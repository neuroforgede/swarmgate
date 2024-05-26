const TLS_DISABLED = process.env.TLS_DISABLED === '1' || process.env.TLS_DISABLED === 'true';

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