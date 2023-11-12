import express from 'express';
import Docker from 'dockerode';
import bodyParser from 'body-parser';
import audit from 'express-requests-logger'
import morgan from 'morgan';
import * as http from 'http';

const app = express();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const label = "owned-by";
const labelValue = "secret-value";

app.use(bodyParser.json());
app.use(morgan('combined'))
// app.use(audit());

app.head('/_ping', (req, res) => {
  // Check if the docker daemon is reachable
  docker.ping((err, data) => {
    if (err) {
      res.status(500).json({ message: err.message });
    } else {
      res.status(200).send();
    }
  });
});

app.get('/_ping', (req, res) => {
  // Check if the docker daemon is reachable
  docker.ping((err, data) => {
    if (err) {
      res.status(500).json({ message: err.message });
    } else {
      res.status(200).send();
    }
  });
});

app.get('/version', async (req, res) => {
  try {
    const versionInfo = await docker.version();
    res.json(versionInfo);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/:version/version', async (req, res) => {
  try {
    const versionInfo = await docker.version();
    res.json(versionInfo);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/:version/nodes', async (req, res) => {
  try {
    // Fetching all nodes
    const nodes = await docker.listNodes();

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

// Define the routes you want to expose
app.post('/:version/services/create', async (req, res) => {
  // Add ownership label to the service creation request
  const serviceSpec = req.body;
  try {
    serviceSpec.Labels = { ...serviceSpec.Labels, [label]: labelValue };
    if(Array.isArray(serviceSpec.TaskTemplate.ContainerSpec.Mounts)) {
      for(const mount of serviceSpec.TaskTemplate.ContainerSpec.Mounts) {
        if(mount.Type == 'volume' || mount.Type == 'cluster') {
          if(await doesVolumeExist(mount.Source)) {
            if(!await isVolumeOwned(mount.Source)) {
              res.status(403).send(`Access denied: Volume ${mount.Source} is not owned.`);
              return;
            }
          }
          const volumeOptions = mount.VolumeOptions || {};
          mount.VolumeOptions.Labels = { ...volumeOptions.Labels || {}, [label]: labelValue };
          mount.volumeOptions = volumeOptions;
        }
      }
    }

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
      const authHeader = req.headers['X-Registry-Auth'];
      updateSpec.Labels = { ...updateSpec.Labels, [label]: labelValue };
      updateSpec.version = req.query.version;
      updateSpec.registryAuthFrom = req.query.registryAuthFrom;
      updateSpec.rollback = req.query.rollback;

      // TODO: patch containerspec

      if(Array.isArray(updateSpec.TaskTemplate.ContainerSpec.Mounts)) {
        for(const mount of updateSpec.TaskTemplate.ContainerSpec.Mounts) {
          if(mount.Type == 'volume' || mount.Type == 'cluster') {
            if(await doesVolumeExist(mount.Source)) {
              if(!await isVolumeOwned(mount.Source)) {
                res.status(403).send(`Access denied: Volume ${mount.Source} is not owned.`);
                return;
              }
            }
            const volumeOptions = mount.VolumeOptions || {};
            mount.VolumeOptions.Labels = { ...volumeOptions.Labels || {}, [label]: labelValue };
            mount.volumeOptions = volumeOptions;
          }
        }
      }

      const service = docker.getService(serviceId);

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
    // TODO: push down filtering
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
        insertDefaults: req.query.insertDefaults === '1',
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
      details: req.query.details === '1',
      follow: req.query.follow === '1',
      stdout: req.query.stdout === '1',
      stderr: req.query.stderr === '1',
      since: req.query.since as any,
      timestamps: req.query.timestamps === '1',
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
    const tasks = await docker.listTasks();
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
    const networks = await docker.listNetworks();
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
      const networkInfo = await network.inspect();
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
    const secrets = await docker.listSecrets();
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
    const configs = await docker.listConfigs();
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
  const volumeSpec = req.body;
  volumeSpec.Labels = { ...volumeSpec.Labels, [label]: labelValue };

  try {
    const volume = await docker.createVolume(volumeSpec);
    res.status(201).json(volume);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

// Endpoint to list all owned volumes
app.get('/:version/volumes', async (req, res) => {
  try {
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
      await volume.remove({});
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


// Add other endpoints as needed

const port = 8080;
app.listen(port, () => {
  console.log(`Proxy server running on http://localhost:${port}`);
});