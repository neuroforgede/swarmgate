import { before } from "lodash";
import express from "express";
import bodyParser from 'body-parser';
import http from "http";
import Docker from "dockerode";
import {setupRoutes} from "./routes";

function startApp(port: number) {
    var app = express();
    app.use(bodyParser.json());
    const router = setupRoutes("someTenant");
    app.use('/', router);

    console.log("starting server on port " + port);
    return http.createServer(app).listen(port);
}

describe('proxy', () => {
    let server: http.Server;
    let docker: Docker;

    beforeEach(() => {
        server = startApp(9999);
        docker = new Docker({
            host: 'localhost',
            port: 9999,
            protocol: 'http'
        });
    });

    afterEach(() => {
        server.close();
    });

    it('should return 200', async () => {
        const dockerVersion = await docker.version();
        expect(dockerVersion).toBeDefined();
        expect(dockerVersion.Version).toBeDefined();
    });

});