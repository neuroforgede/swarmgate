// from https://github.com/BretFisher/node-docker-good-defaults
import http from 'http';

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

request.end();