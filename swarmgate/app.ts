import express from 'express';
import Docker, { VolumeCreateResponse } from 'dockerode';
import bodyParser from 'body-parser';
import morgan from 'morgan';
import * as http from 'http';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// in production we should not allow the local volume driver if possible
// as ownership checking does not really work for it
const ALLOWED_REGULAR_VOLUME_DRIVERS = process.env.ALLOWED_REGULAR_VOLUMES_DRIVERS?.split(',') || ['local'];
const KNOWN_VOLUME_TYPES = ['bind', 'volume', 'tmpfs', 'npipe', 'cluster'];
const ALLOWED_VOLUME_TYPES = process.env.ALLOWED_VOLUME_TYPES?.split(',') || ['bind', 'volume', 'tmpfs', 'npipe', 'cluster'];
const ALLOW_PORT_EXPOSE = process.env.ALLOW_PORT_EXPOSE === '1' || process.env.ALLOW_PORT_EXPOSE === 'true';
const SERVICE_ALLOW_LISTED_NETWORKS = process.env.SERVICE_ALLOW_LISTED_NETWORKS?.split(',') || [];

const tenantLabel = "com.github.com.nfcompose.swarmgate.tenant";
// some older versions have OWNER_LABEL_VALUE set but not TENANT_NAME
const tenantLabelValue = process.env.TENANT_NAME || process.env.OWNER_LABEL_VALUE;

const TLS_DISABLED = process.env.TLS_DISABLED === '1' || process.env.TLS_DISABLED === 'true';

if (!tenantLabelValue) {
  console.error("TENANT_NAME environment variable is not set.");
  process.exit(1);
}

const NAME_PREFIX = process.env.NAME_PREFIX || tenantLabelValue;

// Virtual Swarm Mode = simulating a swarm per tenant
// We prefix all resources with the tenant name internally
// but we don't expose the tenant name to the user
const VIRTUAL_SWARM_MODE = process.env.VIRTUAL_SWARM_MODE === '1' || process.env.VIRTUAL_SWARM_MODE === 'true';

function isResourceNameAllowed(name: string): boolean {
  if (VIRTUAL_SWARM_MODE) {
    // in virtual swarm mode, we don't expose the tenant name to the user
    // so we don't need to check for it
    return true;
  }
  if (name.startsWith(NAME_PREFIX)) {
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

export const app = express();
app.disable('etag');

morgan.token('client-cn', (req: any) => {
  if (!req.client || !req.client.authorized) {
    return 'Unauthorized';
  }
  const cert = req.socket.getPeerCertificate();
  if (!cert) {
    return 'Unauthorized';
  }
  if (cert.subject) {
    return cert.subject.CN;
  }
  return 'Unauthorized';
});

const clientCertAuthMiddleware = (req: any, res: any, next: any) => {
  if (TLS_DISABLED) {
    return next();
  }
  // Check if the client certificate is present and authorized
  if (req.client.authorized) {
    next(); // Proceed to the next middleware/route handler
  } else {
    // If the client is not authorized, return a 401 Unauthorized response
    res.status(401).send('Access denied: Invalid client certificate');
  }
};
if (!TLS_DISABLED) {
  app.use(morgan(':remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" - Client-CN: :client-cn'));
} else {
  app.use(morgan(':remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" - Client-CN: TLS Disabled'))
};
app.use(clientCertAuthMiddleware);
app.use(bodyParser.json());


// app.use(audit());

// manually call the docker socket to return all relevant headers
function pingWithHeaders(): Promise<{ data: string, headers: http.IncomingHttpHeaders }> {
  const socketPath = '/var/run/docker.sock';
  const options = {
    socketPath,
    path: '/_ping',
  };
  return new Promise((resolve, reject) => {
    const request = http.get(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        resolve({
          data: data,
          headers: res.headers
        });
      });
    });

    request.on('error', (e) => {
      reject(e.message);
    });
  });
}

app.head('/_ping', async (req, res) => {
  try {
    const pingResponse = await pingWithHeaders();
    for (const key of Object.keys(pingResponse.headers)) {
      res.header(key, pingResponse.headers[key]);
    }
    res.send();
  } catch (error: any) {
    console.log(error);
    console.error(error);
    res.status(500).json({ message: error.message });
  }
});

app.get('/_ping', async (req, res) => {
  try {
    const pingResponse = await pingWithHeaders();
    for (const key of Object.keys(pingResponse.headers)) {
      res.header(key, pingResponse.headers[key]);
    }
    res.send(pingResponse.data);
  } catch (error: any) {
    console.log(error);
    console.error(error);
    res.status(500).json({ message: error.message });
  }
});

app.get('/:version?/version', async (req, res) => {
  try {
    const version = req.params.version;
    if (version) {
      console.log(`Received version request for API version: ${version}`);
    }
    const versionInfo = await docker.version();
    res.json(versionInfo);
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ message: error.message });
  }
});

app.get('/:version?/nodes', async (req, res) => {
  try {
    const filters = req.query.filters as any;
    // Fetching all nodes
    const nodes = await docker.listNodes({
      filters: filters,
    });

    // Since we don't modify nodes and there's no concept of ownership,
    // we directly return all nodes. Modify this as per your requirement.
    res.json(nodes);
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ message: error.message });
  }
});

// Endpoint to get Docker info
app.get('/:version?/info', async (req, res) => {
  try {
    const info = await docker.info();
    res.json(info);
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ message: error.message });
  }
});


// Services

function augmentServiceSpecWithTenantName(serviceSpec: Docker.CreateServiceOptions): Docker.CreateServiceOptions {
  if (!VIRTUAL_SWARM_MODE) {
    return serviceSpec;
  }

  // deep copy serviceSpec
  serviceSpec = JSON.parse(JSON.stringify(serviceSpec));

  // prefix service name with tenant name
  serviceSpec.Name = `${NAME_PREFIX}-${serviceSpec.Name}`;

  const taskTemplate = serviceSpec.TaskTemplate as TaskTemplate;
  // prefix network names with tenant name
  if (taskTemplate?.Networks) {
    for (const network of taskTemplate.Networks) {
      network.Target = `${NAME_PREFIX}-${network.Target}`;
    }
  }
  // prefix secret names with tenant name
  if (taskTemplate?.ContainerSpec?.Secrets) {
    for (const secret of taskTemplate.ContainerSpec.Secrets) {
      secret.SecretName = `${NAME_PREFIX}-${secret.SecretName}`;
    }
  }
  // prefix config names with tenant name
  if (taskTemplate?.ContainerSpec?.Configs) {
    for (const config of taskTemplate.ContainerSpec.Configs) {
      config.ConfigName = `${NAME_PREFIX}-${config.ConfigName}`;
    }
  }
  // prefix volume names with tenant name
  if (taskTemplate?.ContainerSpec?.Mounts) {
    for (const mount of taskTemplate.ContainerSpec.Mounts) {
      if (mount.Type == 'volume' || mount.Type == 'cluster') {
        mount.Source = `${NAME_PREFIX}-${mount.Source}`;
      }
    }
  }
  return serviceSpec;
}

function isServiceOwned(service: Docker.Service): boolean {
  if (!service.Spec?.Name) {
    return false;
  }
  if (!isResourceNameAllowed(service.Spec?.Name)) {
    return false;
  }
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
    Labels?: { [key: string]: string }
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

app.post('/:version?/services/create', async (req, res) => {
  // Add ownership label to the service creation request
  const serviceSpec: Docker.CreateServiceOptions = augmentServiceSpecWithTenantName(req.body);
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

    const authHeader = req.headers['X-Registry-Auth'];
    if (authHeader) {
      const auth = JSON.parse(Buffer.from(authHeader as string, 'base64').toString('utf-8'));
      const service = await docker.createService(auth, serviceSpec);
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

app.post('/:version?/services/:id/update', async (req, res) => {
  const serviceId = req.params.id;
  const updateSpec: any = augmentServiceSpecWithTenantName(req.body);

  if (await isOwnedService(serviceId)) {
    try {
      const taskTemplate: TaskTemplate = updateSpec.TaskTemplate as TaskTemplate;

      if (taskTemplate) {
        // might be null in case of rollback
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

      const authHeader = req.headers['X-Registry-Auth'];
      if (authHeader) {
        const auth = JSON.parse(Buffer.from(authHeader as string, 'base64').toString('utf-8'));
        const response = await service.update(auth, updateSpec);
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

app.get('/:version?/services', async (req, res) => {
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

app.get('/:version?/services/:id', async (req, res) => {
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

app.delete('/:version?/services/:id', async (req, res) => {
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

app.get('/:version?/services/:id/logs', async (req, res) => {
  const serviceId = req.params.id;

  if (!(await isOwnedService(serviceId))) {
    return res.status(403).json({ message: 'Access Denied: Service not owned' });
  }

  try {
    const service = docker.getService(serviceId);
    const logs = await service.logs({
      details: req.query.details === '1' || req.query.details === 'true',
      follow: req.query.follow === '1' || req.query.follow === 'true',
      stdout: req.query.stdout === '1' || req.query.stdout === 'true',
      stderr: req.query.stderr === '1' || req.query.stderr === 'true',
      since: req.query.since as any,
      timestamps: req.query.timestamps === '1' || req.query.timestamps === 'true',
      tail: req.query.tail as any,
    });

    res.setHeader('Content-Type', 'text/plain');

    if (logs.pipe) {
      logs.pipe(res);
      req.on('close', () => {
        try {
          (logs as any).destroy();
        } catch (error) {
          console.error(error);
        }
      });
    } else {
      res.send(logs);
    }
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ message: error.message });
  }
});

// Endpoint to list tasks, showing only those related to owned services
app.get('/:version?/tasks', async (req, res) => {
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
app.get('/:version?/tasks/:id', async (req, res) => {
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

app.get('/:version?/tasks/:id/logs', async (req, res) => {
  const taskId = req.params.id;

  if (!(await isTaskOfOwnedService(taskId))) {
    return res.status(403).json({ message: 'Access Denied: Service not owned' });
  }

  try {
    const task = docker.getTask(taskId);
    // dockerode has this, but not in the typings
    const logs = await (task as any).logs({
      details: req.query.details === '1' || req.query.details === 'true',
      follow: req.query.follow === '1' || req.query.follow === 'true',
      stdout: req.query.stdout === '1' || req.query.stdout === 'true',
      stderr: req.query.stderr === '1' || req.query.stderr === 'true',
      since: req.query.since as any,
      timestamps: req.query.timestamps === '1' || req.query.timestamps === 'true',
      tail: req.query.tail as any,
    });

    res.setHeader('Content-Type', 'text/plain');

    if (logs.pipe) {
      logs.pipe(res);
      req.on('close', () => {
        try {
          (logs as any).destroy();
        } catch (error) {
          console.error(error);
        }
      });
    } else {
      res.send(logs);
    }
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ message: error.message });
  }
});

// Networks

function isNetworkOwned(network: Docker.NetworkInspectInfo): boolean {
  if (!isResourceNameAllowed(network.Name)) {
    return false;
  }
  return !!(network.Labels && network.Labels[tenantLabel] == tenantLabelValue);
}

async function isOwnedNetwork(networkId: string): Promise<boolean> {
  try {
    const network = await docker.getNetwork(networkId).inspect();
    return network && isNetworkOwned(network);
  } catch (error) {
    console.error(error);
    return false;
  }
}

function augmentNetworkSpecWithTenantName(networkSpec: Docker.NetworkCreateOptions): Docker.NetworkCreateOptions {
  if (!VIRTUAL_SWARM_MODE) {
    return networkSpec;
  }

  // deep copy networkSpec
  networkSpec = JSON.parse(JSON.stringify(networkSpec));

  // prefix network name with tenant name
  networkSpec.Name = `${NAME_PREFIX}-${networkSpec.Name}`;

  return networkSpec;
}

// Endpoint to create a network with ownership label
app.post('/:version?/networks/create', async (req, res) => {
  const networkSpec: Docker.NetworkCreateOptions = augmentNetworkSpecWithTenantName(req.body);
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
app.get('/:version?/networks', async (req, res) => {
  try {
    // TODO: push down ownership filtering
    const filters = req.query.filters as any;
    const networks = await docker.listNetworks({
      filters: filters,
    });
    const ownedNetworks = networks.filter((net) => isNetworkOwned(net));
    res.json(ownedNetworks);
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ message: error.message });
  }
});

// Endpoint to delete a network, respecting ownership
app.delete('/:version?/networks/:id', async (req, res) => {
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
app.get('/:version?/networks/:id', async (req, res) => {
  const networkId = req.params.id;

  if (await isOwnedNetwork(networkId)) {
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
  if (!secret.Spec?.Name) {
    return false;
  }
  if (!isResourceNameAllowed(secret.Spec?.Name)) {
    return false;
  }
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

function augmentSecretSpecWithTenantName(secretSpec: Docker.SecretSpec): Docker.SecretSpec {
  if (!VIRTUAL_SWARM_MODE) {
    return secretSpec;
  }

  // deep copy secretSpec
  secretSpec = JSON.parse(JSON.stringify(secretSpec));

  // prefix secret name with tenant name
  secretSpec.Name = `${NAME_PREFIX}-${secretSpec.Name}`;

  return secretSpec;
}

// Endpoint to create a secret with ownership label
app.post('/:version?/secrets/create', async (req, res) => {
  const secretSpec: Docker.SecretSpec = augmentSecretSpecWithTenantName(req.body);
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
app.get('/:version?/secrets', async (req, res) => {
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
app.delete('/:version?/secrets/:id', async (req, res) => {
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
app.get('/:version?/secrets/:id', async (req, res) => {
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
app.post('/:version?/secrets/:id/update', async (req, res) => {
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
  if (!config.Spec?.Name) {
    return false;
  }
  if (!isResourceNameAllowed(config.Spec?.Name)) {
    return false;
  }
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

function augmentConfigSpecWithTenantName(configSpec: Docker.ConfigSpec): Docker.ConfigSpec {
  if (!VIRTUAL_SWARM_MODE) {
    return configSpec;
  }

  // deep copy configSpec
  configSpec = JSON.parse(JSON.stringify(configSpec));

  // prefix config name with tenant name
  configSpec.Name = `${NAME_PREFIX}-${configSpec.Name}`;

  return configSpec;
}

async function configIdentifierFromName(configName: string): Promise<string> {
  if(!VIRTUAL_SWARM_MODE) {
    return configName;
  }

  // list all configs with the given name
  const configs = await docker.listConfigs({
    filters: { name: [`${NAME_PREFIX}-${configName}`] }
  });
  const config = configs.find(c => c.Spec?.Name == `${NAME_PREFIX}-${configName}`);
  if (config) {
    return config.ID;
  }
  throw new Error("Config not found");
}

function augmentConfigFilter(filters: any): any {
  if(!VIRTUAL_SWARM_MODE) {
    return filters;
  }

  if (VIRTUAL_SWARM_MODE) {
    if (filters) {
      if (filters.name) {
        const newNameFilters = [];
        if (!Array.isArray(filters.name)) {
          filters.name = [filters.name];
        }
        for (const name of filters.name) {
          const configName = `${NAME_PREFIX}-${name}`;
          newNameFilters.push(configName);
        }
        filters.name = newNameFilters;
      }
    }
  }
  return filters;
}

// Endpoint to create a config with ownership label
app.post('/:version?/configs/create', async (req, res) => {
  try {
    const configSpec: Docker.ConfigSpec = augmentConfigSpecWithTenantName(req.body);
    configSpec.Labels = { ...configSpec.Labels, [tenantLabel]: tenantLabelValue };

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
app.get('/:version?/configs', async (req, res) => {
  try {
    // TODO: push down ownership filtering
    const filters = await augmentConfigFilter(req.query.filters);

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
app.delete('/:version?/configs/:id', async (req, res) => {
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
app.get('/:version?/configs/:id', async (req, res) => {
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
app.post('/:version?/configs/:id/update', async (req, res) => {
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

function isVolumeOwned(volume: Docker.VolumeInspectInfo): boolean {
  if (!isResourceNameAllowed(volume.Name)) {
    // Docker volumes created by volume plugins don't have
    // all labels set, so we can't check ownership
    // based only on that. We have to rely on the name.
    return false;
  }

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

function augmentVolumeSpecWithTenantName(volumeSpec: Docker.VolumeCreateOptions): Docker.VolumeCreateOptions {
  if (!VIRTUAL_SWARM_MODE) {
    return volumeSpec;
  }

  // deep copy volumeSpec
  volumeSpec = JSON.parse(JSON.stringify(volumeSpec));

  // prefix volume name with tenant name
  volumeSpec.Name = `${NAME_PREFIX}-${volumeSpec.Name}`;

  return volumeSpec;
}

function augmentVolumeResponse(volume: Docker.VolumeInspectInfo | Docker.VolumeCreateResponse): Docker.VolumeInspectInfo | Docker.VolumeCreateResponse {
  if (!VIRTUAL_SWARM_MODE) {
    return volume;
  }

  // deep copy volume
  volume = JSON.parse(JSON.stringify(volume));

  // remove tenant name prefix from volume name
  volume.Name = volume.Name.replace(`${NAME_PREFIX}-`, '');

  return volume;
}

async function volumeIdentifierFromName(volumeName: string): Promise<string> {
  if(!VIRTUAL_SWARM_MODE) {
    return volumeName;
  }

  const volumes = await docker.listVolumes({
    filters: { name: [`${NAME_PREFIX}-${volumeName}`] }
  });
  const volume = volumes.Volumes.find(v => v.Name == `${NAME_PREFIX}-${volumeName}`);
  if (volume) {
    return volume.Name.replace(`${NAME_PREFIX}-`, '');
  }
  throw new Error("Volume not found");
}

function augmentVolumeFilter(filters: any): any {
  if(!VIRTUAL_SWARM_MODE) {
    return filters;
  }

  if (VIRTUAL_SWARM_MODE) {
    if (filters) {
      if (filters.name) {
        const newNameFilters = [];
        if (!Array.isArray(filters.name)) {
          filters.name = [filters.name];
        }
        for (const name of filters.name) {
          const volumeName = `${NAME_PREFIX}-${name}`;
          newNameFilters.push(volumeName);
        }
        filters.name = newNameFilters;
      }
    }
  }
  return filters;
}

// Endpoint to create a volume with ownership label

app.post('/:version?/volumes/create', async (req, res) => {
  try {
    const volumeSpec: Docker.VolumeCreateOptions = augmentVolumeSpecWithTenantName(req.body);
    volumeSpec.Labels = { ...volumeSpec.Labels, [tenantLabel]: tenantLabelValue };

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

    // return volume name without tenant name prefix
    const response = augmentVolumeResponse(volume);

    res.status(201).json(response);
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ message: error.message });
  }
});

// Endpoint to list all owned volumes
app.get('/:version?/volumes', async (req, res) => {
  try {
    const filters = augmentVolumeFilter(req.query.filters);

    // TODO: push down ownership filtering
    const volumes = await docker.listVolumes({
      filters: filters,
    });
    const ownedVolumes = volumes.Volumes.filter(v => isVolumeOwned(v));
    res.json({
      Volumes: ownedVolumes.map(v => augmentVolumeResponse(v)),
      Warnings: volumes.Warnings
    });
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ message: error.message });
  }
});

// Endpoint to delete a volume, respecting ownership
app.delete('/:version?/volumes/:name', async (req, res) => {
  try {
    const volumeName = await volumeIdentifierFromName(req.params.name);

    if (await isOwnedVolume(volumeName)) {
      const volume = docker.getVolume(volumeName);
      await volume.remove({
        force: req.query.force === '1' || req.query.force === 'true'
      });
      res.status(204).send(`Volume ${volumeName} deleted successfully.`);
    } else {
      res.status(403).send('Access denied: Volume is not owned.');
    }
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ message: error.message });
  }
});

// Endpoint to inspect a volume, respecting ownership
app.get('/:version?/volumes/:name', async (req, res) => {
  try {
    const volumeName = await volumeIdentifierFromName(req.params.name);

    if (await isOwnedVolume(volumeName)) {
      const volume = await docker.getVolume(volumeName).inspect();
      const response = augmentVolumeResponse(volume);

      res.json(response);
    } else {
      res.status(403).send('Access denied: Volume is not owned.');
    }
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ message: error.message });
  }
});

// Endpoint to update a volume, respecting ownership (only supported for cluster volumes)
app.put('/:version?/volumes/:name', async (req, res) => {
  try {
    const volumeName = await volumeIdentifierFromName(req.params.name);
    
    const version = req.params.version;
    if (await isOwnedVolume(volumeName)) {
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
    } else {
      res.status(403).send('Access denied: Volume is not owned.');
    }
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ message: error.message });
  }
});


app.get('/:version?/distribution/:rest(*)/json', async (req, res) => {
  const rest = req.params.rest;
  try {
    var optsf = {
      path: '/distribution/' + rest + '/json',
      method: 'GET',
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
    console.log(error);
    console.error(error);
    res.status(500).json({ message: error.message });
  }

});


app.get('/:version?/swarm', async (req, res) => {
  try {
    const swarmInspect = await docker.swarmInspect();
    res.json(swarmInspect);
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ message: error.message });
  }
});
