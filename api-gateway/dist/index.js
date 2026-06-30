"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const node_net_1 = __importDefault(require("node:net"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const morgan_1 = __importDefault(require("morgan"));
const http_proxy_middleware_1 = require("http-proxy-middleware"); // 🎯 AJOUT : fixRequestBody ici
const auth_1 = require("./middleware/auth");
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3000;
const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://localhost:8001';
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8002';
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://localhost:8003';
const IS_DOCKER_NETWORK = USER_SERVICE_URL.includes('user-service') ||
    PRODUCT_SERVICE_URL.includes('product-service') ||
    ORDER_SERVICE_URL.includes('order-service');
function envPort(name, fallback) {
    const value = process.env[name];
    if (!value) {
        return fallback;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}
const RABBITMQ_HOST = process.env.RABBITMQ_HOST || (IS_DOCKER_NETWORK ? 'rabbitmq' : 'localhost');
const RABBITMQ_PORT = envPort('RABBITMQ_PORT', 5672);
const DB_USERS_HOST = process.env.DB_USERS_HOST || (IS_DOCKER_NETWORK ? 'db-users' : 'localhost');
const DB_USERS_PORT = envPort('DB_USERS_PORT', 5432);
const DB_PRODUCTS_HOST = process.env.DB_PRODUCTS_HOST || (IS_DOCKER_NETWORK ? 'db-products' : 'localhost');
const DB_PRODUCTS_PORT = envPort('DB_PRODUCTS_PORT', IS_DOCKER_NETWORK ? 5432 : 5433);
const DB_ORDERS_HOST = process.env.DB_ORDERS_HOST || (IS_DOCKER_NETWORK ? 'db-orders' : 'localhost');
const DB_ORDERS_PORT = envPort('DB_ORDERS_PORT', IS_DOCKER_NETWORK ? 5432 : 5434);
const architectureServices = [
    {
        id: 'api-gateway',
        name: 'API Gateway',
        protocol: 'HTTP',
        url: `http://localhost:${PORT}`,
        healthMode: 'http',
        healthPath: '/health',
        notes: 'Point d\'entree unique'
    },
    {
        id: 'user-service',
        name: 'User Service',
        protocol: 'HTTP',
        url: USER_SERVICE_URL,
        healthMode: 'http',
        healthPath: '/health',
        notes: 'Authentification et utilisateurs'
    },
    {
        id: 'product-service',
        name: 'Product Service',
        protocol: 'HTTP',
        url: PRODUCT_SERVICE_URL,
        healthMode: 'http',
        healthPath: '/health',
        notes: 'Catalogue produits'
    },
    {
        id: 'order-service',
        name: 'Order Service',
        protocol: 'HTTP',
        url: ORDER_SERVICE_URL,
        healthMode: 'http',
        healthPath: '/orders/health',
        notes: 'Gestion des commandes'
    },
    {
        id: 'rabbitmq',
        name: 'RabbitMQ',
        protocol: 'AMQP',
        url: `${RABBITMQ_HOST}:${RABBITMQ_PORT}`,
        healthMode: 'tcp',
        host: RABBITMQ_HOST,
        port: RABBITMQ_PORT,
        notes: 'Communication asynchrone'
    },
    {
        id: 'db-users',
        name: 'DB Users',
        protocol: 'PostgreSQL',
        url: `${DB_USERS_HOST}:${DB_USERS_PORT}`,
        healthMode: 'tcp',
        host: DB_USERS_HOST,
        port: DB_USERS_PORT
    },
    {
        id: 'db-products',
        name: 'DB Products',
        protocol: 'PostgreSQL',
        url: `${DB_PRODUCTS_HOST}:${DB_PRODUCTS_PORT}`,
        healthMode: 'tcp',
        host: DB_PRODUCTS_HOST,
        port: DB_PRODUCTS_PORT
    },
    {
        id: 'db-orders',
        name: 'DB Orders',
        protocol: 'PostgreSQL',
        url: `${DB_ORDERS_HOST}:${DB_ORDERS_PORT}`,
        healthMode: 'tcp',
        host: DB_ORDERS_HOST,
        port: DB_ORDERS_PORT
    }
];
const architectureLinks = [
    { from: 'client', to: 'api-gateway', type: 'HTTPS', description: 'Requetes client' },
    { from: 'api-gateway', to: 'user-service', type: 'HTTP', description: 'Proxy /api/users/*' },
    { from: 'api-gateway', to: 'product-service', type: 'HTTP', description: 'Proxy /api/products/*' },
    { from: 'api-gateway', to: 'order-service', type: 'HTTP', description: 'Proxy /api/orders/*' },
    { from: 'user-service', to: 'db-users', type: 'SQL', description: 'CRUD utilisateurs' },
    { from: 'product-service', to: 'db-products', type: 'SQL', description: 'CRUD produits' },
    { from: 'order-service', to: 'db-orders', type: 'SQL', description: 'CRUD commandes' },
    { from: 'order-service', to: 'rabbitmq', type: 'AMQP', description: 'Events commande' }
];
async function checkHttpService(url, healthPath) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const startedAt = Date.now();
    try {
        const response = await fetch(`${url}${healthPath}`, { signal: controller.signal });
        const latencyMs = Date.now() - startedAt;
        return {
            status: (response.ok ? 'up' : 'down'),
            latencyMs,
            endpoint: `${url}${healthPath}`
        };
    }
    catch {
        return {
            status: 'down',
            latencyMs: null,
            endpoint: `${url}${healthPath}`
        };
    }
    finally {
        clearTimeout(timeout);
    }
}
async function checkTcpService(host, port) {
    const startedAt = Date.now();
    return new Promise((resolve) => {
        let settled = false;
        const socket = new node_net_1.default.Socket();
        const done = (status, latencyMs) => {
            if (settled) {
                return;
            }
            settled = true;
            socket.destroy();
            resolve({ status, latencyMs, endpoint: `tcp://${host}:${port}` });
        };
        socket.setTimeout(3000);
        socket.once('connect', () => done('up', Date.now() - startedAt));
        socket.once('timeout', () => done('down', null));
        socket.once('error', () => done('down', null));
        socket.connect(port, host);
    });
}
function architectureHtml() {
    return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Architecture Microservices</title>
  <style>
    :root {
      --bg-1: #fff9ef;
      --bg-2: #e9f7ff;
      --ink: #1d2430;
      --card: #ffffffcc;
      --line: #254062;
      --up: #14784a;
      --down: #b52135;
      --accent: #ff6b35;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
      color: var(--ink);
      background: radial-gradient(circle at 10% 10%, #ffdfb7 0, transparent 45%),
                  radial-gradient(circle at 90% 20%, #b7e8ff 0, transparent 40%),
                  linear-gradient(135deg, var(--bg-1), var(--bg-2));
      padding: 24px;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      backdrop-filter: blur(8px);
      background: #ffffff66;
      border: 1px solid #ffffffcc;
      border-radius: 24px;
      padding: 20px;
      box-shadow: 0 25px 60px #00224a22;
    }

    h1 {
      margin: 0;
      font-size: clamp(1.5rem, 3vw, 2.4rem);
      letter-spacing: 0.02em;
    }

    .sub {
      margin: 8px 0 20px;
      color: #253246;
      opacity: 0.9;
    }

    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 18px;
    }

    .pill {
      border-radius: 999px;
      border: 1px solid #21344d33;
      padding: 6px 12px;
      background: #ffffffb0;
      font-size: 0.9rem;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: 14px;
    }

    .diagram-wrap {
      margin-top: 14px;
      border: 1px solid #19355430;
      border-radius: 18px;
      padding: 10px;
      background: #ffffffa8;
      overflow-x: auto;
    }

    .diagram {
      min-width: 980px;
      width: 100%;
      height: auto;
      display: block;
    }

    .edge {
      stroke: #24507c;
      stroke-width: 2.2;
      fill: none;
    }

    .edge-label {
      font-size: 12px;
      fill: #21415f;
      font-weight: 600;
    }

    .node rect {
      fill: #ffffff;
      stroke: #1a3654;
      stroke-width: 1.5;
      rx: 14;
      ry: 14;
    }

    .node .title {
      font-size: 13px;
      font-weight: 700;
      fill: #1b2e45;
    }

    .node .subtitle {
      font-size: 11px;
      fill: #2f4a67;
    }

    .node.up rect { fill: #ebfff2; stroke: #14784a; }
    .node.down rect { fill: #fff1f4; stroke: #b52135; }
    .node.unknown rect { fill: #f5f8fc; stroke: #6f8398; }

    .card {
      background: var(--card);
      border: 1px solid #17304a26;
      border-radius: 16px;
      padding: 14px;
      box-shadow: 0 12px 24px #0e2f4c12;
      transition: transform 0.25s ease, box-shadow 0.25s ease;
      animation: rise 0.6s ease both;
    }

    .card:hover {
      transform: translateY(-3px);
      box-shadow: 0 20px 30px #0a2a441f;
    }

    .role { font-size: 0.82rem; opacity: 0.7; margin-bottom: 4px; }
    .name { font-size: 1.05rem; font-weight: 700; }
    .small { font-size: 0.85rem; opacity: 0.85; margin-top: 4px; }

    .status {
      margin-top: 10px;
      display: inline-block;
      font-size: 0.8rem;
      padding: 4px 8px;
      border-radius: 999px;
      border: 1px solid transparent;
    }

    .status.up {
      color: var(--up);
      border-color: #14784a44;
      background: #e8fff3;
    }

    .status.down {
      color: var(--down);
      border-color: #b5213540;
      background: #fff0f2;
    }

    .status.unknown {
      color: #5f7286;
      border-color: #5f728640;
      background: #f4f7fb;
    }

    .client { grid-column: 1 / 4; }
    .gateway { grid-column: 5 / 9; }
    .user { grid-column: 1 / 4; }
    .product { grid-column: 5 / 9; }
    .order { grid-column: 9 / 13; }
    .dbu { grid-column: 1 / 4; }
    .dbp { grid-column: 5 / 9; }
    .dbo { grid-column: 9 / 13; }
    .mq { grid-column: 9 / 13; }

    .links {
      margin-top: 18px;
      border-radius: 14px;
      border: 1px dashed #21406455;
      padding: 12px;
      background: #ffffff94;
    }

    .links h2 { margin: 0 0 10px; font-size: 1.1rem; }
    .links ul { margin: 0; padding-left: 18px; }
    .links li { margin: 6px 0; }

    .flow {
      margin-top: 16px;
      overflow-x: auto;
      white-space: nowrap;
      border: 1px solid #1f3a5a33;
      border-radius: 14px;
      padding: 10px;
      background: #ffffffa3;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      color: #1d2f45;
    }

    @keyframes rise {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @media (max-width: 900px) {
      .client, .gateway, .user, .product, .order, .dbu, .dbp, .dbo, .mq { grid-column: 1 / -1; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Vue d'integration des microservices</h1>
    <p class="sub">Cette interface montre la communication entre services, les dependances et le statut en direct.</p>

    <div class="meta">
      <div class="pill" id="last-refresh">Derniere mise a jour: -</div>
      <div class="pill">Rafraichissement auto: 5s</div>
      <div class="pill">Point d'entree: / (Gateway)</div>
    </div>

    <section class="diagram-wrap">
      <svg class="diagram" viewBox="0 0 1200 620" role="img" aria-label="Graphe oriente des microservices">
        <defs>
          <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
            <path d="M0,0 L0,6 L9,3 z" fill="#24507c"></path>
          </marker>
        </defs>

        <line class="edge" marker-end="url(#arrow)" x1="280" y1="110" x2="500" y2="110" />
        <text class="edge-label" x="360" y="96">HTTPS</text>

        <line class="edge" marker-end="url(#arrow)" x1="560" y1="150" x2="210" y2="260" />
        <text class="edge-label" x="350" y="210">HTTP</text>

        <line class="edge" marker-end="url(#arrow)" x1="600" y1="150" x2="600" y2="260" />
        <text class="edge-label" x="612" y="210">HTTP</text>

        <line class="edge" marker-end="url(#arrow)" x1="640" y1="150" x2="990" y2="260" />
        <text class="edge-label" x="810" y="210">HTTP</text>

        <line class="edge" marker-end="url(#arrow)" x1="210" y1="340" x2="210" y2="470" />
        <text class="edge-label" x="220" y="410">SQL</text>

        <line class="edge" marker-end="url(#arrow)" x1="600" y1="340" x2="600" y2="470" />
        <text class="edge-label" x="612" y="410">SQL</text>

        <line class="edge" marker-end="url(#arrow)" x1="990" y1="340" x2="990" y2="470" />
        <text class="edge-label" x="1002" y="410">SQL</text>

        <line class="edge" marker-end="url(#arrow)" x1="1040" y1="260" x2="1040" y2="150" />
        <text class="edge-label" x="1052" y="210">AMQP</text>

        <g class="node" data-id="client" transform="translate(80,70)">
          <rect width="200" height="80"></rect>
          <text class="title" x="12" y="30">Client</text>
          <text class="subtitle" x="12" y="50">Frontend / API Consumer</text>
        </g>

        <g class="node" data-id="api-gateway" transform="translate(500,70)">
          <rect width="200" height="80"></rect>
          <text class="title" x="12" y="30">API Gateway</text>
          <text class="subtitle" x="12" y="50">Routing + JWT + Proxy</text>
        </g>

        <g class="node" data-id="rabbitmq" transform="translate(900,70)">
          <rect width="280" height="80"></rect>
          <text class="title" x="12" y="30">RabbitMQ</text>
          <text class="subtitle" x="12" y="50">AMQP / Event Bus</text>
        </g>

        <g class="node" data-id="user-service" transform="translate(80,260)">
          <rect width="260" height="80"></rect>
          <text class="title" x="12" y="30">User Service</text>
          <text class="subtitle" x="12" y="50">Auth & Users</text>
        </g>

        <g class="node" data-id="product-service" transform="translate(470,260)">
          <rect width="260" height="80"></rect>
          <text class="title" x="12" y="30">Product Service</text>
          <text class="subtitle" x="12" y="50">Catalogue</text>
        </g>

        <g class="node" data-id="order-service" transform="translate(860,260)">
          <rect width="260" height="80"></rect>
          <text class="title" x="12" y="30">Order Service</text>
          <text class="subtitle" x="12" y="50">Orders + Events</text>
        </g>

        <g class="node" data-id="db-users" transform="translate(80,470)">
          <rect width="260" height="80"></rect>
          <text class="title" x="12" y="30">DB Users</text>
          <text class="subtitle" x="12" y="50">PostgreSQL</text>
        </g>

        <g class="node" data-id="db-products" transform="translate(470,470)">
          <rect width="260" height="80"></rect>
          <text class="title" x="12" y="30">DB Products</text>
          <text class="subtitle" x="12" y="50">PostgreSQL</text>
        </g>

        <g class="node" data-id="db-orders" transform="translate(860,470)">
          <rect width="260" height="80"></rect>
          <text class="title" x="12" y="30">DB Orders</text>
          <text class="subtitle" x="12" y="50">PostgreSQL</text>
        </g>
      </svg>
    </section>

    <div class="grid" id="services-grid">
      <div class="card client" data-id="client">
        <div class="role">Client</div>
        <div class="name">Frontend / Consommateur API</div>
        <div class="small">Requetes vers l'API Gateway</div>
      </div>
      <div class="card gateway" data-id="api-gateway">
        <div class="role">Gateway</div>
        <div class="name">API Gateway</div>
        <div class="small">Routage, auth JWT, proxy</div>
        <span class="status">verification...</span>
      </div>
      <div class="card user" data-id="user-service">
        <div class="role">Microservice</div>
        <div class="name">User Service</div>
        <div class="small">auth / register / login / me</div>
        <span class="status">verification...</span>
      </div>
      <div class="card product" data-id="product-service">
        <div class="role">Microservice</div>
        <div class="name">Product Service</div>
        <div class="small">catalogue produits</div>
        <span class="status">verification...</span>
      </div>
      <div class="card order" data-id="order-service">
        <div class="role">Microservice</div>
        <div class="name">Order Service</div>
        <div class="small">commandes + events RabbitMQ</div>
        <span class="status">verification...</span>
      </div>
      <div class="card dbu" data-id="db-users">
        <div class="role">Database</div>
        <div class="name">PostgreSQL Users</div>
        <div class="small">verification TCP dediee</div>
        <span class="status">verification...</span>
      </div>
      <div class="card dbp" data-id="db-products">
        <div class="role">Database</div>
        <div class="name">PostgreSQL Products</div>
        <div class="small">verification TCP dediee</div>
        <span class="status">verification...</span>
      </div>
      <div class="card dbo" data-id="db-orders">
        <div class="role">Database</div>
        <div class="name">PostgreSQL Orders</div>
        <div class="small">verification TCP dediee</div>
        <span class="status">verification...</span>
      </div>
      <div class="card mq" data-id="rabbitmq">
        <div class="role">Message Broker</div>
        <div class="name">RabbitMQ</div>
        <div class="small">verification TCP dediee</div>
        <span class="status">verification...</span>
      </div>
    </div>

    <div class="flow" id="flow">Chargement du flux...</div>

    <section class="links">
      <h2>Canaux de communication</h2>
      <ul id="links-list"></ul>
    </section>
  </div>

  <script>
    async function loadTopology() {
      const response = await fetch('/api/architecture/topology')
      return response.json()
    }

    async function loadStatus() {
      const response = await fetch('/api/architecture/status')
      return response.json()
    }

    function updateStatusCards(statusPayload) {
      const byId = new Map(statusPayload.services.map(service => [service.id, service]))
      document.querySelectorAll('.card[data-id]').forEach(card => {
        const id = card.getAttribute('data-id')
        const statusBadge = card.querySelector('.status')
        if (!statusBadge) {
          return
        }
        const service = byId.get(id)
        if (!service) {
          statusBadge.textContent = 'n/a'
          statusBadge.className = 'status'
          return
        }
        const latencyLabel = service.latencyMs !== null ? ' (' + service.latencyMs + ' ms)' : ''
        statusBadge.textContent = service.status + latencyLabel
        statusBadge.className = 'status ' + service.status
      })

      document.querySelectorAll('.node[data-id]').forEach(node => {
        const id = node.getAttribute('data-id')
        const service = byId.get(id)

        node.classList.remove('up', 'down', 'unknown')
        if (!service) {
          return
        }
        node.classList.add(service.status)
      })

      const date = new Date(statusPayload.checkedAt)
      document.getElementById('last-refresh').textContent = 'Derniere mise a jour: ' + date.toLocaleString()
    }

    function renderTopology(topology) {
      const flow = topology.links
        .map(link => link.from + ' -> ' + link.to + ' [' + link.type + ']')
        .join('    |    ')
      document.getElementById('flow').textContent = flow

      const linksList = document.getElementById('links-list')
      linksList.innerHTML = ''
      topology.links.forEach(link => {
        const item = document.createElement('li')
        item.textContent = link.from + ' -> ' + link.to + ' | ' + link.type + ' | ' + link.description
        linksList.appendChild(item)
      })
    }

    async function refresh() {
      const status = await loadStatus()
      updateStatusCards(status)
    }

    ;(async function bootstrap() {
      const topology = await loadTopology()
      renderTopology(topology)
      await refresh()
      setInterval(refresh, 5000)
    })()
  </script>
</body>
</html>`;
}
// Middleware de sécurité et logging
app.use((0, helmet_1.default)());
app.use((0, cors_1.default)());
app.use((0, morgan_1.default)('combined'));
app.use(express_1.default.json());
// Route de santé (health check)
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.get('/api/architecture/topology', (req, res) => {
    res.json({
        generatedAt: new Date().toISOString(),
        services: architectureServices,
        links: architectureLinks
    });
});
app.get('/api/architecture/status', async (req, res) => {
    const services = await Promise.all(architectureServices.map(async (service) => {
        if (service.healthMode === 'http' && service.healthPath) {
            const health = await checkHttpService(service.url, service.healthPath);
            return {
                ...service,
                ...health
            };
        }
        if (service.healthMode === 'tcp' && service.host && service.port) {
            const health = await checkTcpService(service.host, service.port);
            return {
                ...service,
                ...health
            };
        }
        if (service.healthMode === 'none') {
            return {
                ...service,
                status: 'unknown',
                latencyMs: null,
                endpoint: null
            };
        }
        return {
            ...service,
            status: 'unknown',
            latencyMs: null,
            endpoint: null
        };
    }));
    res.json({
        checkedAt: new Date().toISOString(),
        services
    });
});
app.get('/architecture', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(architectureHtml());
});
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(architectureHtml());
});
// 🔓 Middleware conditionnel pour exclure le login et le register de la vérification JWT
const userAuthWrapper = (req, res, next) => {
    if (req.path === '/login' || req.path === '/register') {
        return next();
    }
    return (0, auth_1.authMiddleware)(req, res, next);
};
// Proxy vers User Service (port 8001)
app.use('/api/users', userAuthWrapper, (0, http_proxy_middleware_1.createProxyMiddleware)({
    target: USER_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/users': '' },
    on: {
        proxyReq: http_proxy_middleware_1.fixRequestBody, // 🎯 AJOUT : pour éviter le timeout sur les POST (Login/Register)
        error: (err, req, res) => {
            res.status(503).json({ error: 'User service indisponible' });
        }
    }
}));
// Proxy vers Product Service (port 8002)
app.use('/api/products', (0, http_proxy_middleware_1.createProxyMiddleware)({
    target: PRODUCT_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/products': '' },
    on: {
        proxyReq: http_proxy_middleware_1.fixRequestBody, // 🎯 AJOUT : au cas où tu crées un produit en POST plus tard
        error: (err, req, res) => {
            res.status(503).json({ error: 'Product service indisponible' });
        }
    }
}));
// Proxy vers Order Service (port 8003)
app.use('/api/orders', auth_1.authMiddleware, (0, http_proxy_middleware_1.createProxyMiddleware)({
    target: ORDER_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: (path) => path === '/' ? '/orders' : `/orders${path}`,
    on: {
        proxyReq: http_proxy_middleware_1.fixRequestBody, // 🎯 LA CORRECTION : Ré-injecte le body consommé par Express pour Spring Boot
        error: (err, req, res) => {
            res.status(503).json({ error: 'Order service indisponible' });
        }
    }
}));
app.listen(PORT, () => {
    console.log(`🚀 API Gateway démarré sur le port ${PORT}`);
});
