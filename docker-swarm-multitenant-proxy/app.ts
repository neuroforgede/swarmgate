import express from 'express';
import Docker from 'dockerode';
import bodyParser from 'body-parser';
import morgan from 'morgan';
import * as http from 'http';
import { resolveTypeReferenceDirective } from 'typescript';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// in production we should not allow the local volume driver if possible
// as ownership checking does not really work for it
const ALLOWED_REGULAR_VOLUME_DRIVERS = process.env.ALLOWED_REGULAR_VOLUMES_DRIVERS?.split(',') || ['local'];
const KNOWN_VOLUME_TYPES = ['bind', 'volume', 'tmpfs', 'npipe', 'cluster'];
const ALLOWED_VOLUME_TYPES = process.env.ALLOWED_VOLUME_TYPES?.split(',') || ['bind', 'volume', 'tmpfs', 'npipe', 'cluster'];
const ALLOW_PORT_EXPOSE = process.env.ALLOW_PORT_EXPOSE === '1' || process.env.ALLOW_PORT_EXPOSE === 'true';
const SERVICE_ALLOW_LISTED_NETWORKS = process.env.ALLOW_LISTED_NETWORKS?.split(',') || [];

const label = "com.github.com/nfcompose/docker-swarm-multitenant-proxy";
const labelValue = process.env.OWNER_LABEL_VALUE;

const TLS_DISABLED = process.env.TLS_DISABLED === '1' || process.env.TLS_DISABLED === 'true';

if (!labelValue) {
  console.error("OWNER_LABEL_VALUE environment variable is not set.");
  process.exit(1);
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

morgan.token('client-cn', (req: any) => {
  if (req.client.authorized && req.socket.getPeerCertificate().subject) {
      return req.socket.getPeerCertificate().subject.CN;
  }
  return 'Unauthorized';
});

const clientCertAuthMiddleware = (req: any, res: any, next: any) => {
  if(req.path == '/_healthz') {
    const ip = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || req.connection.socket.remoteAddress;
    if (ip === "127.0.0.1" || ip === "::1") {
      // only respond to healthchecks from inside the container
      (async () => {
        try {
          await docker.ping();
          res.status(200).send("OK");
        } catch(err: any) {
          console.error(err);
          res.status(500).send("error");
        }
      })();
      return;
    }
  }
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
app.use(clientCertAuthMiddleware);
app.use(bodyParser.json());
if(!TLS_DISABLED) {
  app.use(morgan(':remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" - Client-CN: :client-cn'));
} else {
  app.use(morgan(':remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" - Client-CN: TLS Disabled'))
}

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
    res.status(500).json({ message: error.message });
  }
});

app.get('/version', async (req, res) => {
  try {
    const versionInfo = await docker.version();
    console.log(versionInfo);
    res.json(versionInfo);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/:version/version', async (req, res) => {
  try {
    const version = req.params.version;
    console.log(`Received version request for API version: ${version}`);
    const versionInfo = await docker.version();
    res.json(versionInfo);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/:version/nodes', async (req, res) => {
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
    res.status(500).json({ message: error.message });
  }
});

// Endpoint to get Docker info
app.get('/:version/info', async (req, res) => {
  try {
    const info = await docker.info();
    res.json(info);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

// Services
function isServiceOwned(service: Docker.Service): boolean {
  if (!service.Spec?.Labels) {
    return false;
  }
  return service.Spec?.Labels[label] == labelValue;
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

type TaskTemplate = {
  ContainerSpec?: {
    Secrets?: { SecretName: string }[],
    Configs?: { ConfigName: string }[],
    Mounts?: { Type: string, Source: string, VolumeOptions?: { Driver?: string, Labels?: { [key: string]: string } } }[],
    Labels?: { [key: string]: string }
  },
  Runtime?: string,
  Networks?: { Target: string }[],
  EndpointSpec?: { Ports?: { TargetPort: number, Protocol: string }[] }
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

  if (taskTemplate.EndpointSpec?.Ports) {
    for (const port of taskTemplate.EndpointSpec.Ports) {
      if (!ALLOW_PORT_EXPOSE) {
        res.status(403).send(`Access denied: Exposing ports is not allowed.`);
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
          mount.VolumeOptions.Labels = { ...volumeOptions.Labels || {}, [label]: labelValue };
          mount.volumeOptions = volumeOptions;
        }
      }
    }
  }
  return true;
}

// Define the routes you want to expose
app.post('/:version/services/create', async (req, res) => {
  // Add ownership label to the service creation request
  const serviceSpec: Docker.CreateServiceOptions = req.body;
  try {
    const taskTemplate: TaskTemplate = serviceSpec.TaskTemplate as any;

    if (!await isValidTaskTemplate(res, taskTemplate)) {
      return;
    }

    serviceSpec.Labels = { ...serviceSpec.Labels, [label]: labelValue };
    if (taskTemplate.ContainerSpec) {
      taskTemplate.ContainerSpec.Labels = { ...taskTemplate.ContainerSpec.Labels || {}, [label]: labelValue };
    }

    // TODO: verify privileges, capability-add and capability-drop
    // TODO: setup default ulimits 

    const authHeader = req.headers['X-Registry-Auth'];
    if (authHeader) {
      const auth = JSON.parse(Buffer.from(authHeader as string, 'base64').toString('utf-8'));
      const service = await docker.createService(auth, serviceSpec);
      res.status(201).json(service);
    }
    const service = await docker.createService(serviceSpec);
    res.status(201).json(service);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/:version/services/:id/update', async (req, res) => {
  const serviceId = req.params.id;
  const updateSpec = req.body;

  if (await isOwnedService(serviceId)) {
    try {
      const taskTemplate: TaskTemplate = updateSpec.TaskTemplate as any;

      if (taskTemplate) {
        // might be null in case of rollback
        if (!await isValidTaskTemplate(res, taskTemplate)) {
          return;
        }

        updateSpec.Labels = { ...updateSpec.Labels, [label]: labelValue };
        if (taskTemplate.ContainerSpec) {
          taskTemplate.ContainerSpec.Labels = { ...taskTemplate.ContainerSpec.Labels || {}, [label]: labelValue };
        }
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
      res.status(500).json({ message: error.message });
    }
  } else {
    res.status(403).send('Access denied: Service is not owned.');
  }
});

app.get('/:version/services', async (req, res) => {
  try {
    // TODO: push down filtering of ownership
    const services = await docker.listServices({
      filters: req.query.filters as any,
      status: req.query.status as any,
    });
    const ownedServices = services.filter(s => isServiceOwned(s));
    res.json(ownedServices);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/:version/services/:id', async (req, res) => {
  const serviceId = req.params.id;

  if (await isOwnedService(serviceId)) {
    try {
      const service = await docker.getService(serviceId).inspect({
        insertDefaults: req.query.insertDefaults === '1' || req.query.insertDefaults === 'true',
      });
      res.json(service);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  } else {
    res.status(403).send('Access denied: Service is not owned.');
  }
});

app.delete('/:version/services/:id', async (req, res) => {
  const serviceId = req.params.id;

  if (!(await isOwnedService(serviceId))) {
    return res.status(403).json({ message: 'Access Denied: Service not owned' });
  }

  try {
    const service = docker.getService(serviceId);
    await service.remove({});
    res.status(200).json({ message: 'Service deleted successfully' });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/:version/services/:id/logs', async (req, res) => {
  const serviceId = req.params.id;

  if (!(await isOwnedService(serviceId))) {
    return res.status(403).json({ message: 'Access Denied: Service not owned' });
  }

  try {
    const service = docker.getService(serviceId);
    const logStream = await service.logs({
      details: req.query.details === '1' || req.query.details === 'true',
      follow: req.query.follow === '1' || req.query.follow === 'true',
      stdout: req.query.stdout === '1' || req.query.stdout === 'true',
      stderr: req.query.stderr === '1' || req.query.stderr === 'true',
      since: req.query.since as any,
      timestamps: req.query.timestamps === '1' || req.query.timestamps === 'true',
      tail: req.query.tail as any,
    });

    res.setHeader('Content-Type', 'text/plain');
    logStream.pipe(res);

    req.on('close', () => {
      // logStream.destroy(); // Ensure to close the stream when the client disconnects
    });

  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

// Endpoint to list tasks, showing only those related to owned services
app.get('/:version/tasks', async (req, res) => {
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
app.get('/:version/tasks/:id', async (req, res) => {
  const taskId = req.params.id;

  if (await isTaskOfOwnedService(taskId)) {
    try {
      const task = await docker.getTask(taskId).inspect();
      res.json(task);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  } else {
    res.status(403).send('Access denied: Task does not belong to an owned service.');
  }
});

// Networks

function isNetworkOwned(network: Docker.NetworkInspectInfo): boolean {
  return !!(network.Labels && network.Labels[label] == labelValue);
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

// Endpoint to create a network with ownership label
app.post('/:version/networks/create', async (req, res) => {
  const networkSpec = req.body;
  networkSpec.Labels = { ...networkSpec.Labels, [label]: labelValue };

  try {
    const network = await docker.createNetwork(networkSpec);
    res.status(201).json(network);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

// Endpoint to list all owned networks
app.get('/:version/networks', async (req, res) => {
  try {
    // TODO: push down ownership filtering
    const filters = req.query.filters as any;
    const networks = await docker.listNetworks({
      filters: filters,
    });
    const ownedNetworks = networks.filter((net) => isNetworkOwned(net));
    res.json(ownedNetworks);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

// Endpoint to delete a network, respecting ownership
app.delete('/:version/networks/:id', async (req, res) => {
  const networkId = req.params.id;

  if (await isOwnedNetwork(networkId)) {
    try {
      const network = docker.getNetwork(networkId);
      await network.remove({});
      res.status(200).send(`Network ${networkId} deleted successfully.`);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  } else {
    res.status(403).send('Access denied: Network is not owned.');
  }
});

// Endpoint to inspect a network, respecting ownership
app.get('/:version/networks/:id', async (req, res) => {
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
      res.status(500).json({ message: error.message });
    }
  } else {
    res.status(403).send('Access denied: Network is not owned.');
  }
});

// secrets

function isSecretOwned(secret: Docker.Secret): boolean {
  return !!(secret.Spec && secret.Spec.Labels && secret.Spec.Labels[label] === labelValue);
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
app.post('/:version/secrets/create', async (req, res) => {
  const secretSpec = req.body;
  secretSpec.Labels = { ...secretSpec.Labels, [label]: labelValue };

  try {
    const secret = await docker.createSecret(secretSpec);
    res.status(201).json(secret);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

// Endpoint to list all owned secrets
app.get('/:version/secrets', async (req, res) => {
  try {
    // TODO: push down ownership filtering
    const filters = req.query.filters as any;
    const secrets = await docker.listSecrets({
      filters: filters,
    });
    const ownedSecrets = secrets.filter((sec) => isSecretOwned(sec));
    res.json(ownedSecrets);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

// Endpoint to delete a secret, respecting ownership
app.delete('/:version/secrets/:id', async (req, res) => {
  const secretId = req.params.id;

  if (await isOwnedSecret(secretId)) {
    try {
      const secret = docker.getSecret(secretId);
      await secret.remove({});
      res.status(200).send(`Secret ${secretId} deleted successfully.`);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  } else {
    res.status(403).send('Access denied: Secret is not owned.');
  }
});

// Endpoint to inspect a secret, respecting ownership
app.get('/:version/secrets/:id', async (req, res) => {
  const secretId = req.params.id;

  if (await isOwnedSecret(secretId)) {
    try {
      const secret = docker.getSecret(secretId);
      const secretInfo = await secret.inspect();
      res.json(secretInfo);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  } else {
    // 404 or docker cli is not happy in docker stack creation
    res.status(404).send('Access denied: Secret is not owned.');
  }
});

// Endpoint to update a secret, respecting ownership
app.post('/:version/secrets/:id/update', async (req, res) => {
  const secretId = req.params.id;
  if (await isOwnedSecret(secretId)) {
    const secretSpec = req.body;
    secretSpec.Labels = { ...secretSpec.Labels, [label]: labelValue };
    try {
      secretSpec.version = req.query.version;
      const secret = docker.getSecret(secretId);
      const secretInfo = await secret.update(secretSpec);
      res.json(secretInfo);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  } else {
    res.status(403).send('Access denied: Secret is not owned.');
  }
});


// configs

function isConfigOwned(config: Docker.ConfigInfo): boolean {
  return !!(config.Spec && config.Spec.Labels && config.Spec.Labels[label] === labelValue);
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
app.post('/:version/configs/create', async (req, res) => {
  const configSpec = req.body;
  configSpec.Labels = { ...configSpec.Labels, [label]: labelValue };

  try {
    const config = await docker.createConfig(configSpec);
    res.status(201).json(config);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

// Endpoint to list all owned configs
app.get('/:version/configs', async (req, res) => {
  try {
    // TODO: push down ownership filtering
    const filters = req.query.filters as any;
    const configs = await docker.listConfigs({
      filters: filters,
    });
    const ownedConfigs = configs.filter((conf) => isConfigOwned(conf));
    res.json(ownedConfigs);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

// Endpoint to delete a config, respecting ownership
app.delete('/:version/configs/:id', async (req, res) => {
  const configId = req.params.id;

  if (await isOwnedConfig(configId)) {
    try {
      const config = docker.getConfig(configId);
      await config.remove({});
      res.status(200).send(`Config ${configId} deleted successfully.`);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  } else {
    res.status(403).send('Access denied: Config is not owned.');
  }
});

// Endpoint to inspect a config, respecting ownership
app.get('/:version/configs/:id', async (req, res) => {
  const configId = req.params.id;

  if (await isOwnedConfig(configId)) {
    try {
      const config = docker.getConfig(configId);
      const configInfo = await config.inspect();
      res.json(configInfo);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  } else {
    // 404 or docker cli is not happy in docker stack creation
    res.status(404).send('Access denied: Config is not owned.');
  }
});

// Endpoint to update a config, respecting ownership
app.post('/:version/configs/:id/update', async (req, res) => {
  const configId = req.params.id;

  if (await isOwnedConfig(configId)) {
    const configSpec = req.body;
    configSpec.Labels = { ...configSpec.Labels, [label]: labelValue };
    try {
      configSpec.version = req.query.version;
      const config = docker.getConfig(configId);
      const configInfo = await config.update(configSpec);
      res.json(configInfo);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  } else {
    res.status(403).send('Access denied: Config is not owned.');
  }
});

// volume code

function isVolumeOwned(volume: Docker.VolumeInspectInfo): boolean {
  return !!(volume.Labels && volume.Labels[label] == labelValue);
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
app.post('/:version/volumes/create', async (req, res) => {
  const volumeSpec: Docker.VolumeCreateOptions = req.body;
  volumeSpec.Labels = { ...volumeSpec.Labels, [label]: labelValue };

  try {
    console.log(volumeSpec);
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
    res.status(500).json({ message: error.message });
  }
});

// Endpoint to list all owned volumes
app.get('/:version/volumes', async (req, res) => {
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
    res.status(500).json({ message: error.message });
  }
});

// Endpoint to delete a volume, respecting ownership
app.delete('/:version/volumes/:name', async (req, res) => {
  const volumeName = req.params.name;

  if (await isOwnedVolume(volumeName)) {
    try {
      const volume = docker.getVolume(volumeName);
      await volume.remove({
        force: req.query.force === '1' || req.query.force === 'true'
      });
      res.status(200).send(`Volume ${volumeName} deleted successfully.`);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  } else {
    res.status(403).send('Access denied: Volume is not owned.');
  }
});

// Endpoint to inspect a volume, respecting ownership
app.get('/:version/volumes/:name', async (req, res) => {
  const volumeName = req.params.name;

  if (await isOwnedVolume(volumeName)) {
    try {
      const volume = await docker.getVolume(volumeName).inspect();
      res.json(volume);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  } else {
    res.status(403).send('Access denied: Volume is not owned.');
  }
});

// Endpoint to update a volume, respecting ownership (only supported for cluster volumes)
app.put('/:version/volumes/:name', async (req, res) => {
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
      console.log(error);
      res.status(500).json({ message: error.message });
    }
  } else {
    res.status(403).send('Access denied: Volume is not owned.');
  }
});


app.get('/:version/distribution/:rest(*)', async (req, res) => {
  const rest = req.params.rest;
  try {
    var optsf = {
      path: '/distribution/' + rest,
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
    res.status(500).json({ message: error.message });
  }

});