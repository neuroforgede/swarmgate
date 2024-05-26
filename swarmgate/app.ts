import express from 'express';
import bodyParser from 'body-parser';
import morgan from 'morgan';
import { setupRoutes } from './routes';

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

// some older versions have OWNER_LABEL_VALUE set but not TENANT_NAME
const tenantLabelValue = process.env.TENANT_NAME || process.env.OWNER_LABEL_VALUE;
if (!tenantLabelValue) {
    console.error("TENANT_NAME environment variable is not set.");
    process.exit(1);
}

const router = setupRoutes(tenantLabelValue);
app.use('/', router);