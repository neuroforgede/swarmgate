// adapted from https://github.com/BretFisher/node-docker-good-defaults
import http from 'http';
import https from 'https';

const TLS_DISABLED = process.env.TLS_DISABLED === '1' || process.env.TLS_DISABLED === 'true';

if (!TLS_DISABLED) {
  (process.env as any)["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;
  var options = {
    timeout: 2000,
    host: 'localhost',
    port: process.env.PORT || 8080,
    path: '/_healthz'
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
  var options = {
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