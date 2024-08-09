import express from 'express';
import Docker from 'dockerode';
import * as http from 'http';
import fs from 'fs';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// in production we should not allow the local volume driver if possible
// as ownership checking does not really work for it
const ALLOWED_REGULAR_VOLUME_DRIVERS = process.env.ALLOWED_REGULAR_VOLUMES_DRIVERS?.split(',') || ['local'];
const KNOWN_VOLUME_TYPES = ['bind', 'volume', 'tmpfs', 'npipe', 'cluster'];
const ALLOWED_VOLUME_TYPES = process.env.ALLOWED_VOLUME_TYPES?.split(',') || ['bind', 'volume', 'tmpfs', 'npipe', 'cluster'];
const ALLOW_PORT_EXPOSE = process.env.ALLOW_PORT_EXPOSE === '1' || process.env.ALLOW_PORT_EXPOSE === 'true';
const SERVICE_ALLOW_LISTED_NETWORKS = process.env.SERVICE_ALLOW_LISTED_NETWORKS?.split(',') || [];

const tenantLabel = "com.github.neuroforgede.swarmgate.tenant";

const ONLY_KNOWN_REGISTRIES = process.env.ONLY_KNOWN_REGISTRIES === '1' || process.env.ONLY_KNOWN_REGISTRIES === 'true';

const REGISTRY_AUTH_OVERRIDES_PATH = process.env.REGISTRY_AUTH_OVERRIDES_PATH || '/run/secrets/registry_auth_overrides';

type RegistryAuth = {
    anonymous?: boolean,
    username?: string,
    password?: string,
    email?: string,
    serveraddress?: string
}

type RegistryAuthPerDockerRegistry = {
    [registry: string]: RegistryAuth
}

const registryAuthOverrides: RegistryAuthPerDockerRegistry = {};
try {
    // if the file does not exist, we will just ignore it
    const overrideExists = fs.existsSync(REGISTRY_AUTH_OVERRIDES_PATH);
    if (overrideExists) {
        console.log(`Loading registry auth overrides from ${REGISTRY_AUTH_OVERRIDES_PATH}`);
        const registryAuthOverridesRaw: RegistryAuthPerDockerRegistry = require(REGISTRY_AUTH_OVERRIDES_PATH);
        for (const [registry, auth] of Object.entries(registryAuthOverridesRaw)) {
            registryAuthOverrides[registry] = auth;
        }
    } else {
        console.log(`No registry auth overrides file not found at ${REGISTRY_AUTH_OVERRIDES_PATH}`);
    }
} catch (error: any) {
    console.error(`Failed to load registry auth overrides: ${error.message}`);
}

function getRegistryFromDockerImage(image: string): string {
    const parts = image.split('/');
    if (parts.length < 2) {
        return '';
    }
    return parts[0];
}

function getAuthForRegistry(registry: string): RegistryAuth | undefined {
    return registryAuthOverrides[registry];
}

function getAuthForDockerImage(image: string): {
    auth: RegistryAuth | undefined,
    registry: string
} {
    let registry = getRegistryFromDockerImage(image);
    if (!registry) {
        registry = 'docker.io';
    }
    return {
        auth: getAuthForRegistry(registry),
        registry: registry
    };
}


export function setupRoutes(tenantLabelValue: string) {
    const router = express.Router();
    const namePrefix = process.env.NAME_PREFIX || tenantLabelValue;

    function isResourceNameAllowed(name: string): boolean {
        if (name.startsWith(namePrefix)) {
            return true;
        }
        return false;
    }

    function isKnownMountType(volumeType: string): boolean {
        return KNOWN_VOLUME_TYPES.includes(volumeType);
    }

    function isMountTypeAllowed(volumeType: string): boolean {
        return ALLOWED_VOLUME_TYPES.includes(volumeType);
    }

    function isVolumeDriverAllowed(volumeDriver: string): boolean {
        return ALLOWED_REGULAR_VOLUME_DRIVERS.includes(volumeDriver);
    }

    function proxyRequestToDocker(req: express.Request, res: express.Response) {
        const options = {
            socketPath: '/var/run/docker.sock',
            path: req.url,
            method: req.method,
            headers: req.headers,
        };

        // Create a request to the Unix socket
        const proxyReq = http.request(options, (proxyRes) => {
            // Pipe the response from the Unix socket back to the original response
            res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
            proxyRes.pipe(res);
        });

        // Pipe the original request body to the Unix socket
        req.pipe(proxyReq);

        // Handle errors in the request to the Unix socket
        proxyReq.on('error', (err) => {
            console.error('Error connecting to Unix socket:', err);
            res.writeHead(500);
            res.end('Internal server error');
        });
    }

    function stripAuthInfo(req: express.Request) {
        if (req.get('x-registry-config')) {
            for (const header in req.headers) {
                if (header.toLowerCase() === 'x-registry-config') {
                    delete req.headers[header];
                }
            }
        }

        if (req.get('x-registry-auth')) {
            // strip any extra auth information
            for (const header in req.headers) {
                if (header.toLowerCase() === 'x-registry-auth') {
                    delete req.headers[header];
                }
            }
        }
    }

    function proxyRequestToDockerWithStrippedAuthInfo(req: express.Request, res: express.Response) {
        stripAuthInfo(req);
        proxyRequestToDocker(req, res);       
    }


    function checkPermissionsOnDockerImage(image: string, registryAuth?: RegistryAuth): Promise<{
        success: boolean,
        errorMessage?: string
    }> {
        const headers: { [header: string]: string | string[] } = {};
        if (registryAuth) {
            // make base auth header by using the username and password and base64 encoding them
            // like with basic auth
            headers['x-registry-auth'] = Buffer.from(JSON.stringify({
                username: registryAuth.username!,
                password: registryAuth.password!,
                serveraddress: registryAuth.serveraddress!,
                email: registryAuth.email,
            })).toString("base64url");
        }

        const options = {
            socketPath: '/var/run/docker.sock',
            path: `/distribution/${image}/json`,
            method: 'GET',
            headers: headers,
        };

        return new Promise((resolve, reject) => {
            const proxyReq = http.request(options, (proxyRes: http.IncomingMessage) => {
                let data = '';
                proxyRes.on('data', (chunk) => {
                    data += chunk;
                });
                proxyRes.on('end', () => {
                    if (proxyRes.statusCode === 200) {
                        resolve({ success: true });
                    } else {
                        const parsed: { message: string } = JSON.parse(data);
                        resolve({ success: false, errorMessage: parsed.message });
                    }
                });
            });

            proxyReq.on('error', (err) => {
                console.error('Error connecting to Unix socket:', err);
                resolve({
                    success: false,
                    errorMessage: 'Failed to check permissions on Docker image.'
                });
            });

            proxyReq.end();
        });
    }

    // app.use(audit());

    // basic plumbing, no need to check for ownership
    // also, these don't change the state of the system
    // as they are only GETs
    router.head('/_ping', proxyRequestToDockerWithStrippedAuthInfo);
    router.get('/_ping', proxyRequestToDockerWithStrippedAuthInfo);
    router.get('/:version?/version', proxyRequestToDockerWithStrippedAuthInfo);
    router.get('/:version?/nodes', proxyRequestToDockerWithStrippedAuthInfo);
    router.get('/:version?/nodes/:id', proxyRequestToDockerWithStrippedAuthInfo);
    router.get('/:version?/info', proxyRequestToDockerWithStrippedAuthInfo);

    // make image resolution work
    router.get('/:version?/distribution/:name/json', async (req: express.Request, res: express.Response) => {
        console.log("distribution json for image", req.params.name);

        stripAuthInfo(req);

        const registryAuth = getAuthForDockerImage(req.params.name);
        if (ONLY_KNOWN_REGISTRIES && !registryAuth) {
            res.status(403).send('Access denied: Only known registries are allowed.');
            return;
        }
        
        const permissionCheckResult = await checkPermissionsOnDockerImage(req.params.name, registryAuth.auth);
        if (!permissionCheckResult.success) {
            res.status(403).send("Permission check failed, Error: " + permissionCheckResult.errorMessage);
            return;
        }

        if(registryAuth.auth && !registryAuth.auth.anonymous) {
            req.headers['x-registry-auth'] = Buffer.from(JSON.stringify({
                username: registryAuth.auth.username!,
                password: registryAuth.auth.password!,
                serveraddress: registryAuth.auth.serveraddress!,
                email: registryAuth.auth.email,
            })).toString("base64url");
        }

        proxyRequestToDockerWithStrippedAuthInfo(req, res);
    });

    // ATTENTION: we dont support requests to /:version?/swarm as this as this would give access to the swarm join token and break isolation

    // Services
    function isServiceOwned(service: Docker.Service): boolean {
        if (!service.Spec?.Labels) {
            return false;
        }
        return service.Spec?.Labels[tenantLabel] == tenantLabelValue;
    }

    async function isOwnedService(serviceId: string): Promise<boolean> {
        try {
            const service = await docker.getService(serviceId).inspect();
            return service && isServiceOwned(service);
        } catch (error) {
            return false;
        }
    }

    function doesVolumeExist(volumeName: string): Promise<boolean> {
        return new Promise((resolve, reject) => {
            docker.getVolume(volumeName).inspect((err, data) => {
                if (err) {
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });
    }

    async function isValidEndpointSpec(
        res: express.Response,
        endpointSpec: Docker.EndpointSpec): Promise<boolean> {
        if (endpointSpec.Ports) {
            for (const port of endpointSpec.Ports) {
                if (!ALLOW_PORT_EXPOSE) {
                    res.status(403).send(`Access denied: Exposing ports is not allowed.`);
                    return false;
                }
            }
        }
        return true;
    }

    type TaskTemplate = {
        ContainerSpec?: {
            Secrets?: { SecretName: string }[],
            Configs?: { ConfigName: string }[],
            Mounts?: { Type: string, Source: string, VolumeOptions?: { Driver?: string, Labels?: { [key: string]: string } } }[],
            Labels?: { [key: string]: string },
            Image: string
        },
        Runtime?: string,
        Networks?: { Target: string }[],
    }
    // returns true if we should continue
    async function isValidTaskTemplate(
        res: express.Response,
        taskTemplate: TaskTemplate): Promise<boolean> {
        const containerSpec = taskTemplate?.ContainerSpec;
        if (taskTemplate?.Runtime != 'plugin' && taskTemplate?.Runtime != 'attachment') {
            if (!containerSpec) {
                res.status(400).send(`ContainerSpec is required in TaskTemplate.`);
                return false;
            }
        }

        if (taskTemplate.Networks) {
            for (const network of taskTemplate.Networks) {
                if (SERVICE_ALLOW_LISTED_NETWORKS.includes(network.Target)) {
                    // explicitly allowed. Example: Traefik Ingress network
                    continue;
                }
                if (!await isOwnedNetwork(network.Target)) {
                    res.status(403).send(`Access denied: Network ${network.Target} is not owned.`);
                    return false;
                }
            }
        }

        if (containerSpec) {
            if (containerSpec.Secrets) {
                for (const secret of containerSpec.Secrets) {
                    if (!await isOwnedSecret(secret.SecretName)) {
                        res.status(403).send(`Access denied: Secret ${secret.SecretName} is not owned.`);
                        return false;
                    }
                }
            }
            if (containerSpec.Configs) {
                for (const config of containerSpec.Configs) {
                    if (!await isOwnedConfig(config.ConfigName)) {
                        res.status(403).send(`Access denied: Config ${config.ConfigName} is not owned.`);
                        return false;
                    }
                }
            }
            if (Array.isArray(containerSpec.Mounts)) {
                for (const mount of (taskTemplate as any).ContainerSpec.Mounts) {
                    if (!isKnownMountType(mount.Type)) {
                        res.status(400).send(`Mount type ${mount.Type} is not supported.`);
                        return false;
                    }
                    if (!isMountTypeAllowed(mount.Type)) {
                        res.status(400).send(`Mount type ${mount.Type} is not allowed.`);
                        return false;
                    }

                    // we can't enforce volume existance before we actually run this
                    // as this is not how docker swarm handles it
                    // so we can only check ownership on non existant volumes
                    //
                    // problem: if the volume is created by e.g. by the default local
                    // driver, we can't check ownership reliably, as the volume
                    // might not exist on this host.
                    // This is why for security reasons using the local volume driver
                    // should be disabled in most cases.
                    // if this ever becomes a requirement for this proxy
                    // we will have to keep track of volumes in a database ourselves
                    if (mount.Type == 'volume' || mount.Type == 'cluster') {
                        if (await doesVolumeExist(mount.Source)) {
                            if (!await isOwnedVolume(mount.Source)) {
                                res.status(403).send(`Access denied: Volume ${mount.Source} is not owned.`);
                                return false;
                            }
                        }
                        const volumeOptions = mount.VolumeOptions || {};
                        mount.VolumeOptions.Labels = { ...volumeOptions.Labels || {}, [tenantLabel]: tenantLabelValue };
                        mount.volumeOptions = volumeOptions;
                    }
                }
            }
        }
        return true;
    }

    // Define the routes you want to expose
    router.post('/:version?/services/create', async (req, res) => {
        // Add ownership label to the service creation request
        const serviceSpec: Docker.CreateServiceOptions = req.body;
        try {
            const taskTemplate: TaskTemplate = serviceSpec.TaskTemplate as any;

            if (!serviceSpec.Name) {
                res.status(400).send(`Service name is required.`);
                return;
            }
            if (!isResourceNameAllowed(serviceSpec.Name)) {
                res.status(400).send(`Service name ${serviceSpec.Name} is not allowed.`);
                return;
            }

            if (!await isValidTaskTemplate(res, taskTemplate)) {
                return;
            }

            if (serviceSpec.EndpointSpec && !await isValidEndpointSpec(res, serviceSpec.EndpointSpec)) {
                return;
            }

            serviceSpec.Labels = { ...serviceSpec.Labels, [tenantLabel]: tenantLabelValue };
            if (taskTemplate.ContainerSpec) {
                taskTemplate.ContainerSpec.Labels = { ...taskTemplate.ContainerSpec.Labels || {}, [tenantLabel]: tenantLabelValue };
            }

            // TODO: verify privileges, capability-add and capability-drop
            // TODO: setup default ulimits

            const registryAuth = getAuthForDockerImage(taskTemplate.ContainerSpec!.Image);
            if (ONLY_KNOWN_REGISTRIES && !registryAuth) {
                res.status(403).send('Access denied: Only known registries are allowed.');
                return;
            }

            const permissionCheckResult = await checkPermissionsOnDockerImage(taskTemplate.ContainerSpec!.Image, registryAuth.auth);
            if (!permissionCheckResult.success) {
                res.status(403).send("Permission check failed, Error: " + permissionCheckResult.errorMessage);
                return;
            }

            if (registryAuth.auth && !registryAuth.auth.anonymous) {
                const service = await docker.createService({
                    username: registryAuth.auth.username!,
                    password: registryAuth.auth.password!,
                    serveraddress: registryAuth.auth.serveraddress!,
                    email: registryAuth.auth.email,
                }, serviceSpec);
                res.status(201).json(service);
                return;
            }
            const service = await docker.createService(serviceSpec);
            res.status(201).json(service);
        } catch (error: any) {
            console.error(error);
            res.status(500).json({ message: error.message });
        }
    });

    router.post('/:version?/services/:id/update', async (req, res) => {
        const serviceId = req.params.id;
        const updateSpec = req.body;

        if (await isOwnedService(serviceId)) {
            try {
                const taskTemplate: TaskTemplate = updateSpec.TaskTemplate as any;

                // might be null in case of rollback
                if (taskTemplate) {
                    if (!await isValidTaskTemplate(res, taskTemplate)) {
                        return;
                    }

                    updateSpec.Labels = { ...updateSpec.Labels, [tenantLabel]: tenantLabelValue };
                    if (taskTemplate.ContainerSpec) {
                        taskTemplate.ContainerSpec.Labels = { ...taskTemplate.ContainerSpec.Labels || {}, [tenantLabel]: tenantLabelValue };
                    }
                }

                if (updateSpec.EndpointSpec && !await isValidEndpointSpec(res, updateSpec.EndpointSpec)) {
                    return;
                }

                const service = docker.getService(serviceId);

                updateSpec.version = req.query.version;
                updateSpec.registryAuthFrom = req.query.registryAuthFrom;
                updateSpec.rollback = req.query.rollback;

                const registryAuth = getAuthForDockerImage(taskTemplate.ContainerSpec!.Image);
                if (ONLY_KNOWN_REGISTRIES && !registryAuth) {
                    res.status(403).send('Access denied: Only known registries are allowed.');
                    return;
                }

                const permissionCheckResult = await checkPermissionsOnDockerImage(taskTemplate.ContainerSpec!.Image, registryAuth.auth);
                if (!permissionCheckResult.success) {
                    res.status(403).send(permissionCheckResult.errorMessage);
                    return;
                }

                if (registryAuth.auth && !registryAuth.auth.anonymous) {
                    const response = await service.update({
                        username: registryAuth.auth.username!,
                        password: registryAuth.auth.password!,
                        serveraddress: registryAuth.auth.serveraddress!,
                    }, updateSpec);
                    res.json(response);
                    return;
                }

                // Update service with the new specifications
                const response = await service.update(updateSpec);

                res.json(response);
            } catch (error: any) {
                console.error(error);
                res.status(500).json({ message: error.message });
            }
        } else {
            res.status(403).send('Access denied: Service is not owned.');
        }
    });

    router.get('/:version?/services', async (req, res) => {
        try {
            // TODO: push down filtering of ownership
            const services = await docker.listServices({
                filters: req.query.filters as any,
                status: req.query.status as any,
            });
            const ownedServices = services.filter(s => isServiceOwned(s));
            res.json(ownedServices);
        } catch (error: any) {
            console.error(error);
            res.status(500).json({ message: error.message });
        }
    });

    router.get('/:version?/services/:id', async (req, res) => {
        const serviceId = req.params.id;

        if (await isOwnedService(serviceId)) {
            try {
                const service = await docker.getService(serviceId).inspect({
                    insertDefaults: req.query.insertDefaults === '1' || req.query.insertDefaults === 'true',
                });
                res.json(service);
            } catch (error: any) {
                console.error(error);
                res.status(500).json({ message: error.message });
            }
        } else {
            res.status(403).send('Access denied: Service is not owned.');
        }
    });

    router.delete('/:version?/services/:id', async (req, res) => {
        const serviceId = req.params.id;

        if (!(await isOwnedService(serviceId))) {
            return res.status(403).json({ message: 'Access Denied: Service not owned' });
        }

        try {
            const service = docker.getService(serviceId);
            await service.remove({});
            res.status(200).json({ message: 'Service deleted successfully' });
        } catch (error: any) {
            console.error(error);
            res.status(500).json({ message: error.message });
        }
    });


    router.get('/:version?/services/:id/logs', async (req, res) => {
        const serviceId = req.params.id;

        if (!(await isOwnedService(serviceId))) {
            return res.status(403).json({ message: 'Access Denied: Service not owned' });
        }

        proxyRequestToDockerWithStrippedAuthInfo(req, res);
    });

    // Endpoint to list tasks, showing only those related to owned services
    router.get('/:version?/tasks', async (req, res) => {
        try {
            const filters = req.query.filters as any;
            const tasks = await docker.listTasks({
                filters: filters
            });
            const ownedTasks = [];

            for (const task of tasks) {
                if (await isOwnedService(task.ServiceID)) {
                    ownedTasks.push(task);
                }
            }

            res.json(ownedTasks);
        } catch (error: any) {
            console.error(error);
            res.status(500).json({ message: error.message });
        }
    });

    async function isTaskOfOwnedService(taskId: string): Promise<boolean> {
        try {
            const task = await docker.getTask(taskId).inspect();
            return isOwnedService(task.ServiceID);
        } catch (error) {
            console.error(error);
            return false;
        }
    }

    // Endpoint to inspect a task, ensuring it belongs to an owned service
    router.get('/:version?/tasks/:id', async (req, res) => {
        const taskId = req.params.id;

        if (await isTaskOfOwnedService(taskId)) {
            try {
                const task = await docker.getTask(taskId).inspect();
                res.json(task);
            } catch (error: any) {
                console.error(error);
                res.status(500).json({ message: error.message });
            }
        } else {
            res.status(403).send('Access denied: Task does not belong to an owned service.');
        }
    });

    router.get('/:version?/tasks/:id/logs', async (req, res) => {
        const taskId = req.params.id;

        if (!(await isTaskOfOwnedService(taskId))) {
            return res.status(403).json({ message: 'Access Denied: Service not owned' });
        }

        proxyRequestToDockerWithStrippedAuthInfo(req, res);
    });

    // Networks

    function isNetworkOwned(network: Docker.NetworkInspectInfo, includeAllowListed: boolean): boolean {
        if (includeAllowListed && SERVICE_ALLOW_LISTED_NETWORKS.includes(network.Name)) {
            return true;
        }
        return !!(network.Labels && network.Labels[tenantLabel] == tenantLabelValue);
    }

    async function isOwnedNetwork(networkId: string, includeAllowListed: boolean = false): Promise<boolean> {
        try {
            const network = await docker.getNetwork(networkId).inspect();
            return network && isNetworkOwned(network, includeAllowListed);
        } catch (error) {
            console.error(error);
            return false;
        }
    }

    // Endpoint to create a network with ownership label
    router.post('/:version?/networks/create', async (req, res) => {
        const networkSpec = req.body;
        networkSpec.Labels = { ...networkSpec.Labels, [tenantLabel]: tenantLabelValue };

        try {
            if (!networkSpec.Name) {
                res.status(400).send(`Network name is required.`);
                return;
            }
            if (!isResourceNameAllowed(networkSpec.Name)) {
                res.status(400).send(`Network name ${networkSpec.Name} is not allowed.`);
                return;
            }

            const network = await docker.createNetwork(networkSpec);
            res.status(201).json(network);
        } catch (error: any) {
            console.error(error);
            res.status(500).json({ message: error.message });
        }
    });

    // Endpoint to list all owned networks
    router.get('/:version?/networks', async (req, res) => {
        try {
            // TODO: push down ownership filtering
            const filters = req.query.filters as any;
            const networks = await docker.listNetworks({
                filters: filters,
            });
            // list the service allow listed networks as well
            // this is fine, read only only here.
            const ownedNetworks = networks.filter((net) => isNetworkOwned(net, true));
            res.json(ownedNetworks);
        } catch (error: any) {
            console.error(error);
            res.status(500).json({ message: error.message });
        }
    });

    // Endpoint to delete a network, respecting ownership
    router.delete('/:version?/networks/:id', async (req, res) => {
        const networkId = req.params.id;

        if (await isOwnedNetwork(networkId)) {
            try {
                const network = docker.getNetwork(networkId);
                await network.remove({});
                res.status(200).send(`Network ${networkId} deleted successfully.`);
            } catch (error: any) {
                console.error(error);
                res.status(500).json({ message: error.message });
            }
        } else {
            res.status(403).send('Access denied: Network is not owned.');
        }
    });

    // Endpoint to inspect a network, respecting ownership
    router.get('/:version?/networks/:id', async (req, res) => {
        const networkId = req.params.id;

        // allowed to get the service allow listed networks as well
        // this is fine, read only only here.
        if (await isOwnedNetwork(networkId, true)) {
            try {
                const network = docker.getNetwork(networkId);

                // typing is borked, dockerode supports this
                const networkInfo = await (network as any).inspect({
                    verbose: req.query.verbose,
                    scope: req.query.scope,
                });
                res.json(networkInfo);
            } catch (error: any) {
                console.error(error);
                res.status(500).json({ message: error.message });
            }
        } else {
            res.status(403).send('Access denied: Network is not owned.');
        }
    });

    // secrets

    function isSecretOwned(secret: Docker.Secret): boolean {
        return !!(secret.Spec && secret.Spec.Labels && secret.Spec.Labels[tenantLabel] === tenantLabelValue);
    }

    async function isOwnedSecret(secretId: string): Promise<boolean> {
        try {
            const secret = await docker.getSecret(secretId).inspect();
            return secret && isSecretOwned(secret);
        } catch (error) {
            console.error(error);
            return false;
        }
    }

    // Endpoint to create a secret with ownership label
    router.post('/:version?/secrets/create', async (req, res) => {
        const secretSpec = req.body;
        secretSpec.Labels = { ...secretSpec.Labels, [tenantLabel]: tenantLabelValue };

        try {
            if (!secretSpec.Name) {
                res.status(400).send(`Secret name is required.`);
                return;
            }
            if (!isResourceNameAllowed(secretSpec.Name)) {
                res.status(400).send(`Secret name ${secretSpec.Name} is not allowed.`);
                return;
            }

            const secret = await docker.createSecret(secretSpec);
            res.status(201).json(secret);
        } catch (error: any) {
            console.error(error);
            res.status(500).json({ message: error.message });
        }
    });

    // Endpoint to list all owned secrets
    router.get('/:version?/secrets', async (req, res) => {
        try {
            // TODO: push down ownership filtering
            const filters = req.query.filters as any;
            const secrets = await docker.listSecrets({
                filters: filters,
            });
            const ownedSecrets = secrets.filter((sec) => isSecretOwned(sec));
            res.json(ownedSecrets);
        } catch (error: any) {
            console.error(error);
            res.status(500).json({ message: error.message });
        }
    });

    // Endpoint to delete a secret, respecting ownership
    router.delete('/:version?/secrets/:id', async (req, res) => {
        const secretId = req.params.id;

        if (await isOwnedSecret(secretId)) {
            try {
                const secret = docker.getSecret(secretId);
                await secret.remove({});
                res.status(200).send(`Secret ${secretId} deleted successfully.`);
            } catch (error: any) {
                console.error(error);
                res.status(500).json({ message: error.message });
            }
        } else {
            res.status(403).send('Access denied: Secret is not owned.');
        }
    });

    // Endpoint to inspect a secret, respecting ownership
    router.get('/:version?/secrets/:id', async (req, res) => {
        const secretId = req.params.id;

        if (await isOwnedSecret(secretId)) {
            try {
                const secret = docker.getSecret(secretId);
                const secretInfo = await secret.inspect();
                res.json(secretInfo);
            } catch (error: any) {
                console.error(error);
                res.status(500).json({ message: error.message });
            }
        } else {
            // 404 or docker cli is not happy in docker stack creation
            res.status(404).send('Access denied: Secret is not owned.');
        }
    });

    // Endpoint to update a secret, respecting ownership
    router.post('/:version?/secrets/:id/update', async (req, res) => {
        const secretId = req.params.id;
        if (await isOwnedSecret(secretId)) {
            const secretSpec = req.body;
            secretSpec.Labels = { ...secretSpec.Labels, [tenantLabel]: tenantLabelValue };
            try {
                secretSpec.version = req.query.version;
                const secret = docker.getSecret(secretId);
                const secretInfo = await secret.update(secretSpec);
                res.json(secretInfo);
            } catch (error: any) {
                console.error(error);
                res.status(500).json({ message: error.message });
            }
        } else {
            res.status(403).send('Access denied: Secret is not owned.');
        }
    });


    // configs

    function isConfigOwned(config: Docker.ConfigInfo): boolean {
        return !!(config.Spec && config.Spec.Labels && config.Spec.Labels[tenantLabel] === tenantLabelValue);
    }

    async function isOwnedConfig(configId: string): Promise<boolean> {
        try {
            const config = await docker.getConfig(configId).inspect();
            return config && isConfigOwned(config);
        } catch (error) {
            console.error(error);
            return false;
        }
    }

    // Endpoint to create a config with ownership label
    router.post('/:version?/configs/create', async (req, res) => {
        const configSpec = req.body;
        configSpec.Labels = { ...configSpec.Labels, [tenantLabel]: tenantLabelValue };

        try {
            if (!configSpec.Name) {
                res.status(400).send(`Config name is required.`);
                return;
            }
            if (!isResourceNameAllowed(configSpec.Name)) {
                res.status(400).send(`Config name ${configSpec.Name} is not allowed.`);
                return;
            }

            const config = await docker.createConfig(configSpec);
            res.status(201).json(config);
        } catch (error: any) {
            console.error(error);
            res.status(500).json({ message: error.message });
        }
    });

    // Endpoint to list all owned configs
    router.get('/:version?/configs', async (req, res) => {
        try {
            // TODO: push down ownership filtering
            const filters = req.query.filters as any;
            const configs = await docker.listConfigs({
                filters: filters,
            });
            const ownedConfigs = configs.filter((conf) => isConfigOwned(conf));
            res.json(ownedConfigs);
        } catch (error: any) {
            console.error(error);
            res.status(500).json({ message: error.message });
        }
    });

    // Endpoint to delete a config, respecting ownership
    router.delete('/:version?/configs/:id', async (req, res) => {
        const configId = req.params.id;

        if (await isOwnedConfig(configId)) {
            try {
                const config = docker.getConfig(configId);
                await config.remove({});
                res.status(200).send(`Config ${configId} deleted successfully.`);
            } catch (error: any) {
                console.error(error);
                res.status(500).json({ message: error.message });
            }
        } else {
            res.status(403).send('Access denied: Config is not owned.');
        }
    });

    // Endpoint to inspect a config, respecting ownership
    router.get('/:version?/configs/:id', async (req, res) => {
        const configId = req.params.id;

        if (await isOwnedConfig(configId)) {
            try {
                const config = docker.getConfig(configId);
                const configInfo = await config.inspect();
                res.json(configInfo);
            } catch (error: any) {
                console.error(error);
                res.status(500).json({ message: error.message });
            }
        } else {
            // 404 or docker cli is not happy in docker stack creation
            res.status(404).send('Access denied: Config is not owned.');
        }
    });

    // Endpoint to update a config, respecting ownership
    router.post('/:version?/configs/:id/update', async (req, res) => {
        const configId = req.params.id;

        if (await isOwnedConfig(configId)) {
            const configSpec = req.body;
            configSpec.Labels = { ...configSpec.Labels, [tenantLabel]: tenantLabelValue };
            try {
                configSpec.version = req.query.version;
                const config = docker.getConfig(configId);
                const configInfo = await config.update(configSpec);
                res.json(configInfo);
            } catch (error: any) {
                console.error(error);
                res.status(500).json({ message: error.message });
            }
        } else {
            res.status(403).send('Access denied: Config is not owned.');
        }
    });

    // volume code

    function isVolumeOwned(volume: Docker.VolumeInspectInfo): boolean {
        return !!(volume.Labels && volume.Labels[tenantLabel] == tenantLabelValue);
    }

    async function isOwnedVolume(volumeName: string): Promise<boolean> {
        try {
            const volume = await docker.getVolume(volumeName).inspect();
            return volume.Labels && isVolumeOwned(volume);
        } catch (error) {
            console.error(error);
            return false;
        }
    }

    // Endpoint to create a volume with ownership label
    router.post('/:version?/volumes/create', async (req, res) => {
        const volumeSpec: Docker.VolumeCreateOptions = req.body;
        volumeSpec.Labels = { ...volumeSpec.Labels, [tenantLabel]: tenantLabelValue };

        try {
            if (!volumeSpec.Name) {
                res.status(400).send(`Volume name is required.`);
                return;
            }
            if (!isResourceNameAllowed(volumeSpec.Name)) {
                res.status(400).send(`Volume name ${volumeSpec.Name} is not allowed.`);
                return;
            }

            if (!volumeSpec.Driver) {
                res.status(400).send(`Volume driver is required.`);
                return;
            }
            if (!isVolumeDriverAllowed(volumeSpec.Driver)) {
                res.status(400).send(`Volume driver ${volumeSpec.Driver} is not allowed.`);
                return;
            }

            // for cluster volumes verify secret access permissions
            const clusterVolumeSpec = (volumeSpec as any).ClusterVolumeSpec;
            // TOOD: should we disallow creation of volumes if they are not allowed
            // maybe check against mount type?
            if (clusterVolumeSpec.AccessMode && clusterVolumeSpec.AccessMode.Secrets) {
                for (const secret of clusterVolumeSpec.AccessMode.Secrets) {
                    if (!await isOwnedSecret(secret.Secret)) {
                        res.status(403).send(`Access denied: Secret ${secret.Secret} is not owned.`);
                        return;
                    }
                }
            }

            const volume = await docker.createVolume(volumeSpec);
            res.status(201).json(volume);
        } catch (error: any) {
            console.error(error);
            res.status(500).json({ message: error.message });
        }
    });

    // Endpoint to list all owned volumes
    router.get('/:version?/volumes', async (req, res) => {
        try {
            // TODO: push down ownership filtering
            const volumes = await docker.listVolumes({
                filters: req.query.filters as any,
            });
            const ownedVolumes = volumes.Volumes.filter(v => isVolumeOwned(v));
            res.json({
                Volumes: ownedVolumes,
                Warnings: volumes.Warnings
            });
        } catch (error: any) {
            console.error(error);
            res.status(500).json({ message: error.message });
        }
    });

    // Endpoint to delete a volume, respecting ownership
    router.delete('/:version?/volumes/:name', async (req, res) => {
        const volumeName = req.params.name;

        if (await isOwnedVolume(volumeName)) {
            try {
                const volume = docker.getVolume(volumeName);
                await volume.remove({
                    force: req.query.force === '1' || req.query.force === 'true'
                });
                res.status(200).send(`Volume ${volumeName} deleted successfully.`);
            } catch (error: any) {
                console.error(error);
                res.status(500).json({ message: error.message });
            }
        } else {
            res.status(403).send('Access denied: Volume is not owned.');
        }
    });

    // Endpoint to inspect a volume, respecting ownership
    router.get('/:version?/volumes/:name', async (req, res) => {
        const volumeName = req.params.name;

        if (await isOwnedVolume(volumeName)) {
            try {
                const volume = await docker.getVolume(volumeName).inspect();
                res.json(volume);
            } catch (error: any) {
                console.error(error);
                res.status(500).json({ message: error.message });
            }
        } else {
            res.status(403).send('Access denied: Volume is not owned.');
        }
    });

    // Endpoint to update a volume, respecting ownership (only supported for cluster volumes)
    router.put('/:version?/volumes/:name', async (req, res) => {
        const volumeName = req.params.name;
        const version = req.params.version;
        if (await isOwnedVolume(volumeName)) {
            try {
                var optsf = {
                    path: `/${version}/volumes/${volumeName}`,
                    method: 'PUT',
                    statusCodes: {
                        200: true,
                        404: 'no such service',
                        500: 'server error'
                    },
                    headers: req.headers
                };

                const ret = await new docker.modem.Promise(function (resolve, reject) {
                    docker.modem.dial(optsf, function (err, data) {
                        if (err) {
                            return reject(err);
                        }
                        resolve(data);
                    });
                });
                res.send(ret);
            } catch (error: any) {
                console.error(error);
                res.status(500).json({ message: error.message });
            }
        } else {
            res.status(403).send('Access denied: Volume is not owned.');
        }
    });

    return router;
}

