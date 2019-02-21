const _ = require('lodash');
const grpc = require('grpc');
const protoLoader = require('@grpc/proto-loader');
const express = require('express');
const cors = require('cors');
const expressWs = require('express-ws');
const bodyParser = require('body-parser');
const pino = require('pino');
const mapErrorToHttp = require('./utils/mapErrorToHttp');
const createInterval = require('./utils/createInterval');
const createCredentials = require('./utils/createCredentials');
const createMetadataMapper = require('./utils/createMetadata');

function createGrpcGateway(config) {
  const app = express();
  expressWs(app);

  app.logger = pino({
    name: 'grpc-gateway',
    level: config.logLevel || 'debug',
  });

  app.set('etag', false);
  app.set('x-powered-by', false);

  if (config.cors) {
    app.use(
      cors({
        origin: config.cors.origin,
        maxAge: 24 * 60 * 60,
        methods: ['GET', 'POST'],
        allowedHeaders: ['accept', 'content-type', 'authorization'],
      }),
    );
  }

  const createMetadata = createMetadataMapper(config.filterHeaders);

  const jsonParser = bodyParser.json();

  _.forOwn(config.protoFiles, (protoRoot) => {
    const definition = protoLoader.loadSync(protoRoot, {
      longs: String,
      enums: String,
      bytes: String,
      arrays: true,
      defaults: true,
      keepCase: false,
      includeDirs: config.protoInclude,
    });
    const pkg = grpc.loadPackageDefinition(definition);

    _.forOwn(definition, (serviceDefinition, serviceName) => {
      _.forOwn(serviceDefinition, (methodDefinition) => {
        const Service = _.get(pkg, serviceName);
        const createService = () =>
          new Service(
            config.api.host,
            createCredentials(config.api.credentials),
          );

        app.logger.debug(`register route ${methodDefinition.path}`);
        if (methodDefinition.requestStream && methodDefinition.responseStream) {
          app.ws(methodDefinition.path, (ws, req) => {
            app.logger.debug(`bidi-stream: ${methodDefinition.path}`);

            const service = createService();
            const metadata = createMetadata(req);
            const call = service[methodDefinition.originalName](metadata);

            let isAlive = true;
            let cancelPing = createInterval(this.pingInterval || 15000, () => {
              if (!isAlive) {
                handleError("Ping timeout exceeded");
                return;
              }

              isAlive = false;
              ping();
            });

            const ping = () => ws.ping(null, false, handleError);

            const pongMsg = JSON.stringify({ pong: true });
            const pong = () => ws.send(pongMsg, handleError);

            const handleError = (error) => {
              if (error) {
                cancelPing();
                call.cancel();
                ws.close();
                app.logger.error(error);
              }
            };

            ws.on('pong', () => isAlive = true);

            ws.on('message', (json) => {
              try {
                const message = JSON.parse(json);
                if (message.ping) {
                  pong();
                } else {
                  call.write(message);
                }
              } catch (error) {
                handleError(error);
              }
            });

            ws.on('close', () => {
              call.cancel();
              cancelPing();
            });

            call.on('data', (message) => {
              const json = JSON.stringify({ ok: true, payload: message });
              ws.send(json, handleError);
            });

            call.on('error', (error) => {
              const json = JSON.stringify({
                ok: false,
                payload: mapErrorToHttp(error),
              });
              ws.send(json, handleError);
            });

            call.on('end', () => {
              ws.close();
            });
          });
        } else if (methodDefinition.responseStream) {
          app.post(methodDefinition.path, jsonParser, (req, res) => {
            app.logger.debug(`server-stream: ${methodDefinition.path}`);

            const service = createService();
            const metadata = createMetadata(req);
            const call = service[methodDefinition.originalName](
              req.body,
              metadata,
            );

            let isHeadersSent = false;
            const sendHeaders = () => {
              if (!isHeadersSent) {
                isHeadersSent = true;
                res.writeHead(200, {
                  'content-type': 'application/jsonstream',
                });
              }
            };

            const write = (message) => {
              sendHeaders();
              res.write(JSON.stringify(message) + '\n');
            };

            const cancelPing = createInterval(
              config.pingInterval ? config.pingInterval : 15000,
              () => write({ ping: true }),
            );

            call.on('data', (message) => {
              app.logger.debug(`server-stream: ${methodDefinition.path} data`);
              write({ ok: true, payload: message });
            });

            call.on('error', (error) => {
              app.logger.debug(`server-stream: ${methodDefinition.path} error`);
              write({ ok: false, payload: error });
            });

            call.on('end', () => {
              app.logger.debug(`server-stream: ${methodDefinition.path} end`);
              sendHeaders();
              res.end();
              cancelPing();
            });

            req.on('close', () => {
              app.logger.debug(`server-stream: ${methodDefinition.path} close`);
              call.cancel();
              cancelPing();
            });
          });
        } else if (methodDefinition.requestStream) {
          app.post(methodDefinition.path, (req, res) => {
            app.logger.debug(`client-stream: ${methodDefinition.path}`);

            res.status(501);
            res.json({
              ok: false,
              payload: {
                code: 501,
                message: 'Not Implemented',
              },
            });
          });
        } else {
          app.post(methodDefinition.path, jsonParser, (req, res) => {
            app.logger.debug(`unary: ${methodDefinition.path}`);

            const service = createService();
            const metadata = createMetadata(req);

            const method = service[methodDefinition.originalName];
            app.logger.debug('Unary request', req.body, metadata);
            const call = method.call(
              service,
              req.body,
              metadata,
              (error, response) => {
                if (error) {
                  app.logger.error('Unary error', error);
                  const outError = mapErrorToHttp(error);
                  res.status(outError.status);
                  res.json({
                    ok: false,
                    payload: outError,
                  });
                } else {
                  app.logger.debug('Unary response', response);
                  res.json({
                    ok: true,
                    payload: response,
                  });
                }
              },
            );

            req.on('close', () => {
              app.logger.debug(`unary: ${methodDefinition.path} close`);
              call.cancel();
            });
          });
        }
      });
    });
  });

  app.get('/info', jsonParser, (req, res) => {
    const pkg = require('../package.json');
    const data = {
      name: pkg.name,
      version: pkg.version,
    };
    res.json({ status: 'OK', data });
  });

  app.use((req, res, next) => {
    res.status(404);
    res.json({
      ok: false,
      payload: {
        code: 404,
        message: 'Not Found',
      },
    });
  });

  app.use((error, req, res, next) => {
    app.logger.error(error);

    res.status(500);
    res.json({
      ok: false,
      payload: {
        code: 500,
        message: 'Internal Error',
      },
    });
  });

  return app;
}

module.exports = createGrpcGateway;