// adapted from https://github.com/BretFisher/node-docker-good-defaults
import http from 'http';
import https from 'https';
import fs from 'fs';

const TLS_DISABLED = process.env.TLS_DISABLED === '1' || process.env.TLS_DISABLED === 'true';

if (!TLS_DISABLED) {
  if(!process.env.TLS_KEY_FILE || !process.env.TLS_CERT_FILE || !process.env.TLS_CA_FILE) {
    console.error('ERROR: TLS is enabled but one or more of the following environment variables are not set: TLS_KEY_FILE, TLS_CERT_FILE, TLS_CA_FILE');
    process.exit(1);
  }

  let options = {
    timeout: 2000,
    host: 'localhost',
    port: process.env.PORT || 8080,
    path: '/_healthz',
    key: fs.readFileSync(process.env.TLS_KEY_FILE),
    cert: fs.readFileSync(process.env.TLS_CERT_FILE),
    ca: fs.readFileSync(process.env.TLS_CA_FILE),
  };

  var request = https.request(options, (res) => {
    console.info('STATUS: ' + res.statusCode);
    process.exitCode = (res.statusCode === 200) ? 0 : 1;
    process.exit();
  });

  request.on('error', function (err) {
    console.error('ERROR', err);
    process.exit(1);
  });

  request.end();
} else {
  let options = {
    timeout: 2000,
    host: 'localhost',
    port: process.env.PORT || 8080,
    path: '/_healthz'
  };

  var request = http.request(options, (res) => {
    console.info('STATUS: ' + res.statusCode);
    process.exitCode = (res.statusCode === 200) ? 0 : 1;
    process.exit();
  });

  request.on('error', function (err) {
    console.error('ERROR', err);
    process.exit(1);
  });
}