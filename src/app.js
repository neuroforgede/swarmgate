"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const dockerode_1 = __importDefault(require("dockerode"));
const body_parser_1 = __importDefault(require("body-parser"));
const app = express_1.default();
const docker = new dockerode_1.default({ socketPath: '/var/run/docker.sock' });
const label = "owned-by";
const labelValue = "secret-value";
app.use(body_parser_1.default.json());
// Define the routes you want to expose
app.post('/services/create', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    // Add ownership label to the service creation request
    const serviceSpec = req.body;
    serviceSpec.Labels = Object.assign(Object.assign({}, serviceSpec.Labels), { label: labelValue });
    try {
        const service = yield docker.createService(serviceSpec);
        res.status(201).json(service);
    }
    catch (error) {
        res.status(500).json({ message: error.message });
    }
}));
app.get('/services', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const services = yield docker.listServices();
        const ownedServices = services.filter(s => {
            var _a, _b;
            if (!((_a = s.Spec) === null || _a === void 0 ? void 0 : _a.Labels)) {
                return false;
            }
            return ((_b = s.Spec) === null || _b === void 0 ? void 0 : _b.Labels[label]) == labelValue;
        });
        res.json(ownedServices);
    }
    catch (error) {
        res.status(500).json({ message: error.message });
    }
}));
// Add other endpoints as needed
const port = 8000;
app.listen(port, () => {
    console.log(`Proxy server running on http://localhost:${port}`);
});
