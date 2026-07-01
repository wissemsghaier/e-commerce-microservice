import express from 'express'
import net from 'node:net'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware' // 🎯 AJOUT : fixRequestBody ici
import { authMiddleware } from './middleware/auth'

const app = express()
const PORT = process.env.PORT || 3000

const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://localhost:8001'
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8002'
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://localhost:8003'

const IS_DOCKER_NETWORK =
  USER_SERVICE_URL.includes('user-service') ||
  PRODUCT_SERVICE_URL.includes('product-service') ||
  ORDER_SERVICE_URL.includes('order-service')

function envPort(name: string, fallback: number) {
  const value = process.env[name]
  if (!value) {
    return fallback
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const RABBITMQ_HOST = process.env.RABBITMQ_HOST || (IS_DOCKER_NETWORK ? 'rabbitmq' : 'localhost')
const RABBITMQ_PORT = envPort('RABBITMQ_PORT', 5672)

const DB_USERS_HOST = process.env.DB_USERS_HOST || (IS_DOCKER_NETWORK ? 'db-users' : 'localhost')
const DB_USERS_PORT = envPort('DB_USERS_PORT', 5432)

const DB_PRODUCTS_HOST = process.env.DB_PRODUCTS_HOST || (IS_DOCKER_NETWORK ? 'db-products' : 'localhost')
const DB_PRODUCTS_PORT = envPort('DB_PRODUCTS_PORT', IS_DOCKER_NETWORK ? 5432 : 5433)

const DB_ORDERS_HOST = process.env.DB_ORDERS_HOST || (IS_DOCKER_NETWORK ? 'db-orders' : 'localhost')
const DB_ORDERS_PORT = envPort('DB_ORDERS_PORT', IS_DOCKER_NETWORK ? 5432 : 5434)

type ServiceStatus = 'up' | 'down' | 'unknown'
type HealthMode = 'http' | 'tcp' | 'none'

type ArchitectureService = {
  id: string
  name: string
  protocol: string
  url: string
  healthMode: HealthMode
  healthPath?: string
  host?: string
  port?: number
  notes?: string
}

const architectureServices: ArchitectureService[] = [
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
]

const architectureLinks = [
  { from: 'client', to: 'api-gateway', type: 'HTTPS', description: 'Requetes client' },
  { from: 'api-gateway', to: 'user-service', type: 'HTTP', description: 'Proxy /api/users/*' },
  { from: 'api-gateway', to: 'product-service', type: 'HTTP', description: 'Proxy /api/products/*' },
  { from: 'api-gateway', to: 'order-service', type: 'HTTP', description: 'Proxy /api/orders/*' },
  { from: 'user-service', to: 'db-users', type: 'SQL', description: 'CRUD utilisateurs' },
  { from: 'product-service', to: 'db-products', type: 'SQL', description: 'CRUD produits' },
  { from: 'order-service', to: 'db-orders', type: 'SQL', description: 'CRUD commandes' },
  { from: 'order-service', to: 'rabbitmq', type: 'AMQP', description: 'Events commande' }
]

async function checkHttpService(url: string, healthPath: string) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)
  const startedAt = Date.now()

  try {
    const response = await fetch(`${url}${healthPath}`, { signal: controller.signal })
    const latencyMs = Date.now() - startedAt

    return {
      status: (response.ok ? 'up' : 'down') as ServiceStatus,
      latencyMs,
      endpoint: `${url}${healthPath}`
    }
  } catch {
    return {
      status: 'down' as ServiceStatus,
      latencyMs: null,
      endpoint: `${url}${healthPath}`
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function checkTcpService(host: string, port: number) {
  const startedAt = Date.now()

  return new Promise<{ status: ServiceStatus; latencyMs: number | null; endpoint: string }>((resolve) => {
    let settled = false
    const socket = new net.Socket()

    const done = (status: ServiceStatus, latencyMs: number | null) => {
      if (settled) {
        return
      }
      settled = true
      socket.destroy()
      resolve({ status, latencyMs, endpoint: `tcp://${host}:${port}` })
    }

    socket.setTimeout(3000)
    socket.once('connect', () => done('up', Date.now() - startedAt))
    socket.once('timeout', () => done('down', null))
    socket.once('error', () => done('down', null))
    socket.connect(port, host)
  })
}

function shopHtml() {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Boutique Livraison</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800&family=Space+Grotesk:wght@500;700&display=swap');

    :root {
      --bg-1: #fff4e6;
      --bg-2: #dff3ff;
      --ink: #1f2d3d;
      --primary: #ff6b35;
      --primary-2: #ff9f6e;
      --ok: #15784a;
      --danger: #b5253a;
      --card: #ffffffdc;
      --line: #2242602d;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      font-family: 'Outfit', 'Segoe UI', sans-serif;
      background:
        radial-gradient(circle at 88% 8%, #ffd2b6 0, transparent 40%),
        radial-gradient(circle at 8% 16%, #b6e4ff 0, transparent 36%),
        linear-gradient(145deg, var(--bg-1), var(--bg-2));
      padding: 20px;
    }

    .app {
      max-width: 1240px;
      margin: 0 auto;
      display: grid;
      gap: 14px;
    }

    .topnav {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      border: 1px solid #ffffffbc;
      border-radius: 14px;
      padding: 10px;
      background: #ffffffc9;
      box-shadow: 0 10px 24px #17324a1c;
    }

    .brand {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 0.92rem;
      font-weight: 700;
      margin-right: 6px;
      color: #3b5676;
    }

    .nav-link {
      text-decoration: none;
      color: #2e4864;
      border: 1px solid #2e486438;
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 0.8rem;
      font-weight: 700;
      background: #ffffff;
      transition: transform .2s ease, background .2s ease;
    }

    .nav-link:hover {
      transform: translateY(-1px);
      background: #eff7ff;
    }

    .nav-link.active {
      color: #fff;
      border-color: transparent;
      background: linear-gradient(120deg, var(--primary), var(--primary-2));
    }

    .chip {
      margin-left: auto;
      border-radius: 999px;
      border: 1px solid #22426035;
      background: #ffffffb8;
      font-size: 0.8rem;
      padding: 6px 12px;
      font-weight: 700;
    }

    .hero {
      border: 1px solid #ffffffa8;
      border-radius: 20px;
      padding: 18px;
      background: linear-gradient(120deg, #ffffffdb 0%, #fff8f2d8 45%, #eef8ffd8 100%);
      box-shadow: 0 20px 44px #1f2e3f1a;
    }

    .hero h1 {
      margin: 0;
      font-family: 'Space Grotesk', sans-serif;
      font-size: clamp(1.45rem, 3vw, 2.4rem);
    }

    .hero p {
      margin: 8px 0 0;
      color: #3a4f67;
      max-width: 720px;
    }

    .layout {
      display: grid;
      grid-template-columns: 1.45fr 0.95fr;
      gap: 14px;
      align-items: start;
    }

    .panel {
      border: 1px solid var(--line);
      border-radius: 18px;
      background: var(--card);
      padding: 14px;
      box-shadow: 0 12px 28px #12263a17;
    }

    .panel h2 {
      margin: 0 0 10px;
      font-size: 1.1rem;
      font-family: 'Space Grotesk', sans-serif;
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 12px;
    }

    .btn {
      border: 1px solid #22426055;
      border-radius: 10px;
      padding: 8px 12px;
      background: #ffffff;
      color: #1f2d3d;
      font-weight: 700;
      font-size: 0.84rem;
      cursor: pointer;
      transition: transform .2s ease, background .2s ease;
    }

    .btn:hover {
      transform: translateY(-1px);
      background: #f2f8ff;
    }

    .btn.primary {
      background: linear-gradient(120deg, var(--primary), var(--primary-2));
      border-color: transparent;
      color: #fff;
    }

    .btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
      transform: none;
    }

    .page {
      display: none;
    }

    .page.active {
      display: block;
      animation: rise .35s ease both;
    }

    .form-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 10px;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 0.8rem;
      color: #3b546f;
    }

    .field input {
      border: 1px solid #22426044;
      border-radius: 8px;
      padding: 7px 9px;
      font-size: 0.9rem;
      background: #fff;
    }

    .products {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .product {
      border: 1px solid #2242602e;
      border-radius: 12px;
      padding: 10px;
      background: #ffffffcf;
    }

    .product-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .product h3 {
      margin: 0 0 4px;
      font-size: 1rem;
    }

    .meta {
      margin: 0 0 8px;
      font-size: 0.82rem;
      color: #40566f;
    }

    .row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
      font-size: 0.8rem;
    }

    .row input {
      width: 80px;
      border-radius: 8px;
      border: 1px solid #22426044;
      padding: 4px 6px;
    }

    .block {
      border: 1px dashed #22426058;
      border-radius: 11px;
      padding: 10px;
      background: #ffffffb5;
      margin-bottom: 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace;
      font-size: 0.78rem;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .steps {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 6px;
      margin-top: 10px;
    }

    .step {
      text-align: center;
      border: 1px solid #22426045;
      border-radius: 999px;
      padding: 5px 6px;
      font-size: 0.73rem;
      background: #f5f8fc;
      color: #45607d;
      font-weight: 600;
    }

    .step.done {
      background: #e8fff3;
      color: var(--ok);
      border-color: #15784a44;
    }

    .step.now {
      background: #fff2eb;
      color: #c85226;
      border-color: #ff6b3566;
    }

    .feed {
      margin: 0;
      padding-left: 18px;
      max-height: 280px;
      overflow-y: auto;
      font-size: 0.82rem;
    }

    .feed li { margin-bottom: 7px; }
    .ok { color: var(--ok); }
    .ko { color: var(--danger); }

    .detail-hero {
      border: 1px solid #22426033;
      border-radius: 14px;
      background: linear-gradient(120deg, #fffaf4, #eef8ff);
      padding: 12px;
      margin-bottom: 10px;
    }

    .detail-hero h3 {
      margin: 0 0 6px;
      font-size: 1.15rem;
      font-family: 'Space Grotesk', sans-serif;
    }

    .detail-list {
      margin: 0;
      padding-left: 18px;
      font-size: 0.86rem;
      color: #40566f;
    }

    .confirm-box {
      border: 1px solid #22426038;
      border-radius: 14px;
      background: linear-gradient(140deg, #fffaf2, #edf7ff);
      padding: 12px;
      margin-bottom: 10px;
    }

    .confirm-title {
      margin: 0 0 8px;
      font-size: 1.08rem;
      font-family: 'Space Grotesk', sans-serif;
    }

    .eta {
      display: inline-block;
      border: 1px solid #15784a44;
      border-radius: 999px;
      padding: 4px 9px;
      color: #15784a;
      background: #e9fff2;
      font-size: 0.8rem;
      font-weight: 700;
      margin-bottom: 8px;
    }

    .progress {
      width: 100%;
      height: 10px;
      border-radius: 999px;
      background: #dde7f1;
      overflow: hidden;
      margin-bottom: 8px;
    }

    .progress > span {
      display: block;
      height: 100%;
      width: 42%;
      background: linear-gradient(120deg, #ff6b35, #ffb083);
    }

    @keyframes rise {
      from { opacity: 0; transform: translateY(5px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @media (max-width: 980px) {
      .layout { grid-template-columns: 1fr; }
      .products { grid-template-columns: 1fr; }
      .steps { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .chip { margin-left: 0; }
      .form-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="app">
    <nav class="topnav" aria-label="Navigation principale">
      <span class="brand">Livraison Express</span>
      <a class="nav-link" href="/login" data-route="/login">Login</a>
      <a class="nav-link" href="/catalog" data-route="/catalog">Catalogue</a>
      <a class="nav-link" href="/checkout" data-route="/checkout">Checkout</a>
      <a class="nav-link" href="/orders" data-route="/orders">Suivi commande</a>
      <span class="chip" id="session-chip">Session: non connecte</span>
    </nav>

    <section class="hero">
      <h1>Site e-commerce dynamique</h1>
      <p>Parcours guide: login, consulter les produits, passer la commande, suivre la livraison.</p>
    </section>

    <section class="layout">
      <article class="panel">
        <section class="page" data-page="login">
          <h2>1) Ecran Login / Inscription</h2>
          <div class="form-grid">
            <label class="field">Email
              <input id="reg-email" type="email" value="client@example.com" />
            </label>
            <label class="field">Username
              <input id="reg-username" type="text" value="client-demo" />
            </label>
            <label class="field">Password
              <input id="reg-password" type="text" value="Pass1234!" />
            </label>
            <label class="field">Password (login)
              <input id="login-password" type="text" value="Pass1234!" />
            </label>
          </div>
          <div class="toolbar">
            <button class="btn" id="btn-register" data-action="1">Inscription</button>
            <button class="btn primary" id="btn-login" data-action="1">Login</button>
            <button class="btn" id="btn-logout" data-action="1">Logout</button>
          </div>
          <div id="auth-status" class="block">Pas de session active.</div>
        </section>

        <section class="page" data-page="catalog">
          <h2>2) Ecran Catalogue</h2>
          <div class="toolbar">
            <button class="btn" id="btn-refresh" data-action="1">Rafraichir produits</button>
            <button class="btn" id="btn-seed" data-action="1">Generer demo produits</button>
            <button class="btn primary" id="btn-go-checkout" data-action="1">Aller au checkout</button>
          </div>
          <div id="catalog-grid" class="products"></div>
        </section>

        <section class="page" data-page="product">
          <h2>Page produit detaillee</h2>
          <div id="product-detail" class="block">Selectionne un produit depuis le catalogue.</div>
          <div class="toolbar">
            <button class="btn" id="btn-detail-back" data-action="1">Retour catalogue</button>
            <button class="btn primary" id="btn-detail-add" data-action="1">Ajouter au panier</button>
            <button class="btn" id="btn-detail-checkout" data-action="1">Aller checkout</button>
          </div>
        </section>

        <section class="page" data-page="checkout">
          <h2>3) Ecran Checkout</h2>
          <div id="checkout-cart" class="block">Panier vide</div>
          <div class="toolbar">
            <button class="btn" id="btn-clear-cart" data-action="1">Vider panier</button>
            <button class="btn primary" id="btn-place-order" data-action="1">Passer commande</button>
          </div>
        </section>

        <section class="page" data-page="orders">
          <h2>4) Ecran Suivi Commande</h2>
          <div class="toolbar">
            <button class="btn" id="btn-load-orders" data-action="1">Charger commandes</button>
            <button class="btn" id="btn-confirmed" data-action="1">CONFIRMED</button>
            <button class="btn" id="btn-shipped" data-action="1">SHIPPED</button>
            <button class="btn" id="btn-delivered" data-action="1">DELIVERED</button>
          </div>
          <div id="orders-list" class="block">Aucune commande chargee.</div>
          <div id="order-tracker" class="block">Aucune commande active.</div>
        </section>

        <section class="page" data-page="confirmation">
          <h2>Confirmation de commande</h2>
          <div id="confirmation-view" class="block">Aucune commande confirmee.</div>
          <div class="toolbar">
            <button class="btn" id="btn-confirmation-catalog" data-action="1">Continuer les achats</button>
            <button class="btn primary" id="btn-confirmation-orders" data-action="1">Voir suivi commande</button>
          </div>
        </section>
      </article>

      <aside class="panel">
        <h2>Journal</h2>
        <ol id="feed" class="feed"></ol>
      </aside>
    </section>
  </div>

  <script>
    const state = {
      token: localStorage.getItem('shop_token') || null,
      userId: Number(localStorage.getItem('shop_user_id') || '0') || 0,
      userEmail: localStorage.getItem('shop_user_email') || '',
      products: [],
      cart: [],
      orders: [],
      currentOrder: null,
      selectedProduct: null,
      confirmationEta: null,
      busy: false
    }

    const deliverySteps = ['PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED']
    const protectedPaths = ['/catalog', '/product', '/checkout', '/orders', '/confirmation']

    function el(id) {
      return document.getElementById(id)
    }

    function setBusy(value) {
      state.busy = value
      document.querySelectorAll('[data-action]').forEach(btn => {
        btn.disabled = value
      })
    }

    function saveSession() {
      if (state.token) {
        localStorage.setItem('shop_token', state.token)
      }
      if (state.userId) {
        localStorage.setItem('shop_user_id', String(state.userId))
      }
      if (state.userEmail) {
        localStorage.setItem('shop_user_email', state.userEmail)
      }
    }

    function clearSession() {
      localStorage.removeItem('shop_token')
      localStorage.removeItem('shop_user_id')
      localStorage.removeItem('shop_user_email')
    }

    function decodeUserId(token) {
      try {
        const part = token.split('.')[1]
        const normalized = part.replace(/-/g, '+').replace(/_/g, '/')
        const payload = JSON.parse(atob(normalized))
        const id = Number(payload.sub)
        return Number.isFinite(id) ? id : 0
      } catch {
        return 0
      }
    }

    function money(value) {
      return Number(value || 0).toFixed(2) + ' EUR'
    }

    function addFeed(ok, title, details) {
      const item = document.createElement('li')
      item.className = ok ? 'ok' : 'ko'
      item.textContent = '[' + new Date().toLocaleTimeString() + '] ' + title + ' | ' + details
      el('feed').prepend(item)
    }

    function apiCall(url, options) {
      return fetch(url, options).then(async response => {
        const raw = await response.text()
        let payload = raw
        try {
          payload = raw ? JSON.parse(raw) : {}
        } catch {
          payload = raw
        }
        if (!response.ok) {
          throw new Error('HTTP ' + response.status + ' - ' + (typeof payload === 'string' ? payload : JSON.stringify(payload)))
        }
        return payload
      })
    }

    function requireAuth() {
      if (!state.token) {
        throw new Error('Login requis')
      }
    }

    function withAction(label, work) {
      setBusy(true)
      return Promise.resolve()
        .then(work)
        .catch(error => {
          const message = error instanceof Error ? error.message : String(error)
          addFeed(false, label, message)
          if (message.toLowerCase().includes('login requis')) {
            navigate('/login')
          }
        })
        .finally(() => {
          setBusy(false)
        })
    }

    function renderSessionUi() {
      const connected = !!state.token
      el('session-chip').textContent = connected
        ? 'Session: connecte (' + (state.userEmail || ('id ' + state.userId)) + ')'
        : 'Session: non connecte'

      el('auth-status').textContent = connected
        ? 'Connecte. Tu peux acceder au catalogue, checkout et suivi.'
        : 'Pas de session active.'
    }

    function normalizePath(pathname) {
      if (pathname === '/' || pathname === '/shop') {
        return state.token ? '/catalog' : '/login'
      }
      if (['/login', '/catalog', '/product', '/checkout', '/orders', '/confirmation'].includes(pathname)) {
        return pathname
      }
      return '/login'
    }

    function renderPage(path) {
      const route = normalizePath(path)
      document.querySelectorAll('.page').forEach(page => {
        page.classList.remove('active')
      })

      const activePage = document.querySelector('.page[data-page="' + route.slice(1) + '"]')
      if (activePage) {
        activePage.classList.add('active')
      }

      document.querySelectorAll('.nav-link').forEach(link => {
        const isActive = link.getAttribute('data-route') === route
        link.classList.toggle('active', isActive)
      })

      if (route === '/checkout') {
        renderCheckoutCart()
      }

      if (route === '/product') {
        renderProductDetail()
      }

      if (route === '/orders') {
        renderOrdersList()
        renderOrderTracker()
      }

      if (route === '/confirmation') {
        renderConfirmation()
      }
    }

    function navigate(path) {
      const route = normalizePath(path)
      if (protectedPaths.includes(route) && !state.token) {
        history.pushState({}, '', '/login')
        renderPage('/login')
        return
      }
      history.pushState({}, '', route)
      renderPage(route)
    }

    function renderCatalog() {
      const root = el('catalog-grid')
      if (!state.products.length) {
        root.innerHTML = '<div class="meta">Aucun produit. Clique sur "Generer demo produits".</div>'
        return
      }
      root.innerHTML = state.products.map(product => {
        return '<article class="product">' +
          '<h3>' + product.name + '</h3>' +
          '<p class="meta">Prix: ' + money(product.price) + ' | Stock: ' + (product.stock || 0) + '</p>' +
          '<div class="row"><span>Quantite</span><input id="qty-' + product.id + '" type="number" min="1" value="1" /></div>' +
          '<div class="product-actions">' +
            '<button class="btn" data-view-product="' + product.id + '">Voir details</button>' +
            '<button class="btn" data-add-product="' + product.id + '">Ajouter au panier</button>' +
          '</div>' +
        '</article>'
      }).join('')
    }

    function addToCart(productId, quantity) {
      const product = state.products.find(item => Number(item.id) === Number(productId))
      if (!product) {
        addFeed(false, 'Panier', 'Produit introuvable')
        return
      }
      const qty = Number(quantity) > 0 ? Number(quantity) : 1
      const existing = state.cart.find(item => Number(item.id) === Number(product.id))
      if (existing) {
        existing.quantity += qty
      } else {
        state.cart.push({
          id: product.id,
          name: product.name,
          price: Number(product.price || 0),
          quantity: qty
        })
      }
      addFeed(true, 'Panier', 'Produit ajoute')
      renderCheckoutCart()
    }

    function renderCheckoutCart() {
      if (!state.cart.length) {
        el('checkout-cart').textContent = 'Panier vide'
        return
      }
      const lines = state.cart.map(item => item.name + ' x' + item.quantity + ' = ' + money(item.quantity * item.price))
      const total = state.cart.reduce((sum, item) => sum + item.quantity * item.price, 0)
      el('checkout-cart').textContent = lines.join('\n') + '\n----------------\nTotal: ' + money(total)
    }

    function renderProductDetail() {
      const detail = el('product-detail')
      const product = state.selectedProduct
      if (!product) {
        detail.textContent = 'Selectionne un produit depuis le catalogue.'
        return
      }

      detail.innerHTML =
        '<div class="detail-hero">' +
          '<h3>' + product.name + '</h3>' +
          '<p class="meta">Prix: ' + money(product.price) + ' | Stock: ' + (product.stock || 0) + '</p>' +
          '<p class="meta">' + (product.description || 'Produit du catalogue') + '</p>' +
          '<ul class="detail-list">' +
            '<li>Livraison estimee en 20-35 min</li>' +
            '<li>Preparation prioritaire en cuisine</li>' +
            '<li>Suivi en temps reel de la commande</li>' +
          '</ul>' +
        '</div>' +
        '<div class="row"><span>Quantite</span><input id="detail-qty" type="number" min="1" value="1" /></div>'
    }

    function renderConfirmation() {
      const view = el('confirmation-view')
      const order = state.currentOrder
      if (!order) {
        view.textContent = 'Aucune commande confirmee.'
        return
      }

      const eta = state.confirmationEta || '20-35 min'
      const amount = money(order.totalAmount || 0)

      view.innerHTML =
        '<div class="confirm-box">' +
          '<p class="confirm-title">Commande #' + order.id + ' confirmee</p>' +
          '<div class="eta">Arrivee estimee: ' + eta + '</div>' +
          '<div class="progress"><span></span></div>' +
          '<p class="meta">Ton livreur se dirige vers le restaurant puis vers ton adresse.</p>' +
          '<p class="meta">Montant de la commande: ' + amount + '</p>' +
        '</div>'
    }

    function renderOrdersList() {
      if (!state.orders.length) {
        el('orders-list').textContent = 'Aucune commande chargee.'
        return
      }
      const lines = state.orders.map(order => {
        return '#' + order.id + ' | statut=' + order.status + ' | total=' + money(order.totalAmount)
      })
      el('orders-list').textContent = lines.join('\n')
    }

    function renderOrderTracker() {
      const order = state.currentOrder
      if (!order) {
        el('order-tracker').textContent = 'Aucune commande active.'
        return
      }
      const status = order.status || 'PENDING'
      const idx = deliverySteps.indexOf(status)
      const chips = deliverySteps.map((step, i) => {
        let cls = 'step'
        if (i < idx) {
          cls += ' done'
        }
        if (i === idx) {
          cls += ' now'
        }
        return '<div class="' + cls + '">' + step + '</div>'
      }).join('')

      el('order-tracker').innerHTML =
        '<div><strong>Commande #' + order.id + '</strong></div>' +
        '<div>Statut courant: ' + status + '</div>' +
        '<div class="steps">' + chips + '</div>'
    }

    function register() {
      const email = el('reg-email').value.trim()
      const username = el('reg-username').value.trim()
      const password = el('reg-password').value
      if (!email || !username || !password) {
        throw new Error('Email, username, password sont obligatoires')
      }
      return apiCall('/api/users/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, username, password })
      }).then(() => {
        addFeed(true, 'Inscription', 'Compte cree')
        el('auth-status').textContent = 'Inscription OK. Tu peux faire login.'
      })
    }

    function login() {
      const email = el('reg-email').value.trim()
      const password = el('login-password').value
      if (!email || !password) {
        throw new Error('Email et password sont obligatoires')
      }
      return apiCall('/api/users/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      }).then(payload => {
        state.token = payload.access_token
        state.userId = decodeUserId(payload.access_token)
        state.userEmail = email
        saveSession()
        renderSessionUi()
        addFeed(true, 'Login', 'Connexion reussie')
        return loadProducts().then(() => navigate('/catalog'))
      })
    }

    function logout() {
      state.token = null
      state.userId = 0
      state.userEmail = ''
      state.cart = []
      state.orders = []
      state.currentOrder = null
      state.selectedProduct = null
      state.confirmationEta = null
      clearSession()
      renderSessionUi()
      renderCheckoutCart()
      renderOrdersList()
      renderOrderTracker()
      renderProductDetail()
      renderConfirmation()
      addFeed(true, 'Logout', 'Session fermee')
      navigate('/login')
    }

    function loadProducts() {
      requireAuth()
      return apiCall('/api/products/products', { method: 'GET' }).then(payload => {
        state.products = Array.isArray(payload) ? payload : (payload.data || [])
        renderCatalog()
        addFeed(true, 'Catalogue', 'Produits charges')
      })
    }

    function seedProducts() {
      requireAuth()
      const demo = [
        { name: 'Burger Maison', description: 'Pain brioche, boeuf, cheddar', price: 8.9, stock: 25, image_url: 'https://example.com/burger.png' },
        { name: 'Pizza Pepperoni', description: 'Sauce tomate, mozzarella', price: 11.5, stock: 20, image_url: 'https://example.com/pizza.png' },
        { name: 'Jus Orange Frais', description: 'Presse minute', price: 3.2, stock: 50, image_url: 'https://example.com/juice.png' }
      ]
      return Promise.all(demo.map(item => {
        return apiCall('/api/products/products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item)
        })
      })).then(() => {
        addFeed(true, 'Demo', 'Produits demo crees')
        return loadProducts()
      })
    }

    function placeOrder() {
      requireAuth()
      if (!state.cart.length) {
        throw new Error('Panier vide')
      }
      const payload = {
        userId: state.userId || 1,
        items: state.cart.map(item => ({
          productId: item.id,
          quantity: item.quantity,
          unitPrice: item.price
        }))
      }
      return apiCall('/api/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + state.token
        },
        body: JSON.stringify(payload)
      }).then(order => {
        state.cart = []
        state.currentOrder = order
        const etaMin = 20 + Math.floor(Math.random() * 16)
        const etaMax = etaMin + 12
        state.confirmationEta = etaMin + '-' + etaMax + ' min'
        addFeed(true, 'Commande', 'Commande creee avec succes')
        renderCheckoutCart()
        renderConfirmation()
        return loadOrders().then(() => navigate('/confirmation'))
      })
    }

    function loadOrders() {
      requireAuth()
      return apiCall('/api/orders/user/' + (state.userId || 1), {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + state.token }
      }).then(payload => {
        state.orders = Array.isArray(payload) ? payload : []
        if (state.orders.length) {
          state.currentOrder = state.orders.reduce((latest, current) => {
            if (!latest) {
              return current
            }
            return Number(current.id) > Number(latest.id) ? current : latest
          }, state.orders[0])
        }
        renderOrdersList()
        renderOrderTracker()
        addFeed(true, 'Mes commandes', 'Historique charge')
      })
    }

    function updateStatus(status) {
      requireAuth()
      if (!state.currentOrder || !state.currentOrder.id) {
        throw new Error('Aucune commande active')
      }
      return apiCall('/api/orders/' + state.currentOrder.id + '/status?status=' + status, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer ' + state.token }
      }).then(order => {
        state.currentOrder = order
        state.orders = state.orders.map(item => item.id === order.id ? order : item)
        renderOrdersList()
        renderOrderTracker()
        addFeed(true, 'Suivi', 'Statut passe a ' + status)
      })
    }

    function bindEvents() {
      document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', event => {
          event.preventDefault()
          const route = link.getAttribute('data-route')
          navigate(route || '/login')
        })
      })

      window.addEventListener('popstate', () => {
        renderPage(window.location.pathname)
      })

      el('btn-register').addEventListener('click', () => withAction('Inscription', register))
      el('btn-login').addEventListener('click', () => withAction('Login', login))
      el('btn-logout').addEventListener('click', () => withAction('Logout', () => Promise.resolve(logout())))

      el('btn-refresh').addEventListener('click', () => withAction('Catalogue', loadProducts))
      el('btn-seed').addEventListener('click', () => withAction('Demo', seedProducts))
      el('btn-go-checkout').addEventListener('click', () => withAction('Navigation', () => Promise.resolve(navigate('/checkout'))))

      el('catalog-grid').addEventListener('click', event => {
        const target = event.target
        if (!(target instanceof HTMLElement)) {
          return
        }

        const viewId = target.getAttribute('data-view-product')
        if (viewId) {
          const selected = state.products.find(item => Number(item.id) === Number(viewId))
          state.selectedProduct = selected || null
          renderProductDetail()
          navigate('/product')
          return
        }

        const id = target.getAttribute('data-add-product')
        if (!id) {
          return
        }
        const qtyInput = el('qty-' + id)
        const quantity = qtyInput ? Number(qtyInput.value) : 1
        addToCart(Number(id), quantity)
      })

      el('btn-clear-cart').addEventListener('click', () => withAction('Panier', () => {
        state.cart = []
        renderCheckoutCart()
        addFeed(true, 'Panier', 'Panier vide')
      }))

      el('btn-detail-back').addEventListener('click', () => withAction('Navigation', () => Promise.resolve(navigate('/catalog'))))
      el('btn-detail-checkout').addEventListener('click', () => withAction('Navigation', () => Promise.resolve(navigate('/checkout'))))
      el('btn-detail-add').addEventListener('click', () => withAction('Panier', () => {
        if (!state.selectedProduct) {
          throw new Error('Aucun produit selectionne')
        }
        const qtyInput = el('detail-qty')
        const quantity = qtyInput ? Number(qtyInput.value) : 1
        addToCart(Number(state.selectedProduct.id), quantity)
        addFeed(true, 'Produit', 'Ajoute depuis la page detail')
      }))

      el('btn-place-order').addEventListener('click', () => withAction('Commande', placeOrder))
      el('btn-load-orders').addEventListener('click', () => withAction('Mes commandes', loadOrders))
      el('btn-confirmed').addEventListener('click', () => withAction('Suivi', () => updateStatus('CONFIRMED')))
      el('btn-shipped').addEventListener('click', () => withAction('Suivi', () => updateStatus('SHIPPED')))
      el('btn-delivered').addEventListener('click', () => withAction('Suivi', () => updateStatus('DELIVERED')))

      el('btn-confirmation-catalog').addEventListener('click', () => withAction('Navigation', () => Promise.resolve(navigate('/catalog'))))
      el('btn-confirmation-orders').addEventListener('click', () => withAction('Navigation', () => Promise.resolve(navigate('/orders'))))
    }

    ;(function boot() {
      bindEvents()
      renderSessionUi()
      renderCheckoutCart()
      renderOrdersList()
      renderOrderTracker()
      renderCatalog()

      const initialPath = normalizePath(window.location.pathname)
      if (protectedPaths.includes(initialPath) && !state.token) {
        history.replaceState({}, '', '/login')
        renderPage('/login')
      } else {
        history.replaceState({}, '', initialPath)
        renderPage(initialPath)
        if (state.token && initialPath === '/catalog') {
          withAction('Catalogue', loadProducts)
        }
      }

      addFeed(true, 'App', 'Interface e-commerce prete')
    })()
  </script>
</body>
</html>`
}

function architectureHtml() {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Architecture Microservices</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap');

    :root {
      --bg-1: #f2f8ff;
      --bg-2: #ecf2ff;
      --ink: #1c2a3d;
      --card: #ffffffde;
      --line: #1f3e63;
      --up: #14784a;
      --down: #b52135;
      --accent: #1f79d1;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: 'IBM Plex Sans', 'Segoe UI', sans-serif;
      color: var(--ink);
      background: radial-gradient(circle at 8% 12%, #cce5ff 0, transparent 42%),
                  radial-gradient(circle at 92% 18%, #d8dcff 0, transparent 38%),
                  linear-gradient(145deg, var(--bg-1), var(--bg-2));
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
      font-family: 'Space Grotesk', sans-serif;
      font-size: clamp(1.5rem, 3vw, 2.4rem);
      letter-spacing: 0.02em;
    }

    .topnav {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-bottom: 14px;
      border: 1px solid #1f3e6330;
      border-radius: 13px;
      padding: 10px;
      background: #ffffffcd;
      box-shadow: 0 10px 24px #1b2e4520;
    }

    .nav-tag {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 0.82rem;
      letter-spacing: 0.02em;
      font-weight: 700;
      color: #2e4a67;
      margin-right: 4px;
    }

    .nav-link {
      text-decoration: none;
      color: #284867;
      border: 1px solid #2e4a6730;
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 0.8rem;
      font-weight: 700;
      background: #f7fbff;
      transition: transform .2s ease, background .2s ease;
    }

    .nav-link:hover {
      transform: translateY(-1px);
      background: #eaf4ff;
    }

    .nav-link.active {
      color: #fff;
      border-color: transparent;
      background: linear-gradient(120deg, #1f79d1, #48a2ef);
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
      transition: stroke 0.3s ease, stroke-width 0.3s ease;
    }

    .edge.active {
      stroke: #ff6b35;
      stroke-width: 3.6;
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

    .workbench {
      margin-top: 18px;
      display: grid;
      grid-template-columns: 1.2fr 1fr;
      gap: 14px;
    }

    .panel {
      background: #ffffffbf;
      border: 1px solid #203e5f33;
      border-radius: 14px;
      padding: 14px;
    }

    .panel h2 {
      margin: 0 0 10px;
      font-size: 1.1rem;
    }

    .form-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 10px;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 0.86rem;
    }

    .field input {
      border: 1px solid #24416144;
      border-radius: 9px;
      padding: 8px 10px;
      font-size: 0.92rem;
      background: #ffffff;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 10px;
    }

    .btn {
      border: 1px solid #24416155;
      background: #ffffff;
      color: #1f334a;
      border-radius: 10px;
      padding: 8px 12px;
      font-size: 0.86rem;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s ease, background 0.2s ease;
    }

    .btn:hover {
      transform: translateY(-1px);
      background: #f0f8ff;
    }

    .btn.primary {
      background: #ff6b35;
      color: #fff;
      border-color: #ff6b35;
    }

    .btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
      transform: none;
    }

    .token-box,
    .output-box {
      border: 1px dashed #25406266;
      border-radius: 10px;
      padding: 8px;
      background: #ffffffa8;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: 0.78rem;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .token-box { margin-bottom: 8px; }

    .timeline {
      margin: 0;
      padding-left: 18px;
      max-height: 360px;
      overflow-y: auto;
    }

    .timeline li {
      margin-bottom: 8px;
      line-height: 1.3;
    }

    .ok { color: #0f6f43; }
    .ko { color: #a42033; }

    .shop {
      margin-top: 14px;
      display: grid;
      grid-template-columns: 1.2fr 1fr;
      gap: 14px;
    }

    .shop-products {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin-top: 10px;
    }

    .product-card {
      border: 1px solid #24416133;
      border-radius: 11px;
      padding: 10px;
      background: #ffffffd1;
    }

    .product-title {
      margin: 0 0 4px;
      font-size: 0.98rem;
      font-weight: 700;
      color: #1b2d45;
    }

    .product-meta {
      margin: 0 0 8px;
      font-size: 0.82rem;
      color: #304862;
    }

    .qty-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
      font-size: 0.8rem;
    }

    .qty-row input {
      width: 74px;
      border: 1px solid #24416144;
      border-radius: 8px;
      padding: 4px 6px;
    }

    .cart-view {
      margin-bottom: 10px;
      min-height: 72px;
    }

    .delivery-track {
      margin-top: 8px;
      border: 1px dashed #25406266;
      border-radius: 10px;
      padding: 10px;
      background: #ffffffa8;
    }

    .steps {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 6px;
      margin-top: 8px;
    }

    .step {
      text-align: center;
      border: 1px solid #28476533;
      border-radius: 999px;
      padding: 5px 7px;
      font-size: 0.73rem;
      background: #f5f8fc;
      color: #445e7a;
    }

    .step.done {
      background: #e8fff3;
      border-color: #14784a55;
      color: #14784a;
      font-weight: 700;
    }

    .step.now {
      background: #fff2eb;
      border-color: #ff6b3555;
      color: #c44c1f;
      font-weight: 700;
    }

    @keyframes rise {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @media (max-width: 900px) {
      .client, .gateway, .user, .product, .order, .dbu, .dbp, .dbo, .mq { grid-column: 1 / -1; }
      .workbench { grid-template-columns: 1fr; }
      .shop { grid-template-columns: 1fr; }
      .form-grid { grid-template-columns: 1fr; }
      .shop-products { grid-template-columns: 1fr; }
      .steps { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <div class="container">
    <nav class="topnav" aria-label="Navigation principale">
      <span class="nav-tag">Navigation</span>
      <a class="nav-link" href="/">Boutique</a>
      <a class="nav-link" href="/shop">Boutique (alias)</a>
      <a class="nav-link active" href="/architecture">Admin Ops</a>
      <a class="nav-link" href="/admin">Admin (alias)</a>
    </nav>

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

        <line class="edge" data-from="client" data-to="api-gateway" marker-end="url(#arrow)" x1="280" y1="110" x2="500" y2="110" />
        <text class="edge-label" x="360" y="96">HTTPS</text>

        <line class="edge" data-from="api-gateway" data-to="user-service" marker-end="url(#arrow)" x1="560" y1="150" x2="210" y2="260" />
        <text class="edge-label" x="350" y="210">HTTP</text>

        <line class="edge" data-from="api-gateway" data-to="product-service" marker-end="url(#arrow)" x1="600" y1="150" x2="600" y2="260" />
        <text class="edge-label" x="612" y="210">HTTP</text>

        <line class="edge" data-from="api-gateway" data-to="order-service" marker-end="url(#arrow)" x1="640" y1="150" x2="990" y2="260" />
        <text class="edge-label" x="810" y="210">HTTP</text>

        <line class="edge" data-from="user-service" data-to="db-users" marker-end="url(#arrow)" x1="210" y1="340" x2="210" y2="470" />
        <text class="edge-label" x="220" y="410">SQL</text>

        <line class="edge" data-from="product-service" data-to="db-products" marker-end="url(#arrow)" x1="600" y1="340" x2="600" y2="470" />
        <text class="edge-label" x="612" y="410">SQL</text>

        <line class="edge" data-from="order-service" data-to="db-orders" marker-end="url(#arrow)" x1="990" y1="340" x2="990" y2="470" />
        <text class="edge-label" x="1002" y="410">SQL</text>

        <line class="edge" data-from="order-service" data-to="rabbitmq" marker-end="url(#arrow)" x1="1040" y1="260" x2="1040" y2="150" />
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

    <section class="workbench">
      <div class="panel">
        <h2>Scenario dynamique (test visuel)</h2>
        <div class="form-grid">
          <label class="field">Email
            <input id="email" type="email" value="alice+demo@example.com" />
          </label>
          <label class="field">Username
            <input id="username" type="text" value="alice-demo" />
          </label>
          <label class="field">Password
            <input id="password" type="text" value="Pass1234!" />
          </label>
          <label class="field">Nom produit
            <input id="product-name" type="text" value="Laptop Vision" />
          </label>
          <label class="field">Prix
            <input id="product-price" type="number" step="0.01" value="999.99" />
          </label>
          <label class="field">Quantite commande
            <input id="order-qty" type="number" min="1" value="2" />
          </label>
        </div>

        <div class="actions">
          <button id="btn-register" class="btn">1. Register</button>
          <button id="btn-login" class="btn">2. Login</button>
          <button id="btn-create-product" class="btn">3. Creer produit</button>
          <button id="btn-create-order" class="btn">4. Creer commande</button>
          <button id="btn-run-all" class="btn primary">Executer scenario complet</button>
        </div>

        <div id="token-preview" class="token-box">Token: non genere</div>
        <div id="api-output" class="output-box">Sortie API: en attente...</div>
      </div>

      <div class="panel">
        <h2>Timeline des appels internes</h2>
        <ol id="timeline" class="timeline"></ol>
      </div>
    </section>

    <section class="shop">
      <div class="panel">
        <h2>Mode client e-commerce livraison</h2>
        <p class="small">Visualise comme un vrai site: catalogue, panier, commande et livraison.</p>
        <div class="actions">
          <button id="btn-load-products" class="btn">Charger catalogue</button>
          <button id="btn-checkout" class="btn primary">Commander (livraison)</button>
          <button id="btn-my-orders" class="btn">Mes commandes</button>
        </div>
        <div id="shop-products" class="shop-products"></div>
      </div>

      <div class="panel">
        <h2>Panier et suivi livraison</h2>
        <div id="cart-view" class="output-box cart-view">Panier vide</div>
        <div class="actions">
          <button id="btn-status-confirmed" class="btn">CONFIRMED</button>
          <button id="btn-status-shipped" class="btn">SHIPPED</button>
          <button id="btn-status-delivered" class="btn">DELIVERED</button>
        </div>
        <div id="delivery-view" class="delivery-track">Aucune commande active.</div>
      </div>
    </section>
  </div>

  <script>
    const state = {
      token: null,
      user: null,
      product: null,
      order: null,
      cart: [],
      shopProducts: [],
      userOrders: [],
      currentOrder: null,
      busy: false
    }

    const deliveryFlow = ['PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED']

    function q(id) {
      return document.getElementById(id)
    }

    function setBusy(value) {
      state.busy = value
      document.querySelectorAll('.btn').forEach(btn => {
        btn.disabled = value
      })
    }

    function randomizeIdentity() {
      const stamp = Date.now()
      q('email').value = 'alice+' + stamp + '@example.com'
      q('username').value = 'alice-' + stamp
    }

    function addTimeline(ok, title, details) {
      const timeline = q('timeline')
      const item = document.createElement('li')
      item.className = ok ? 'ok' : 'ko'
      item.textContent = '[' + new Date().toLocaleTimeString() + '] ' + title + ' | ' + details
      timeline.prepend(item)
    }

    function showOutput(payload) {
      let text = ''
      if (typeof payload === 'string') {
        text = payload
      } else {
        text = JSON.stringify(payload, null, 2)
      }
      q('api-output').textContent = 'Sortie API:\n' + text
    }

    function money(value) {
      const amount = Number(value || 0)
      return amount.toFixed(2) + ' EUR'
    }

    function renderCart() {
      if (!state.cart.length) {
        q('cart-view').textContent = 'Panier vide'
        return
      }

      const lines = state.cart.map(item => {
        return item.name + ' x' + item.quantity + ' = ' + money(item.quantity * item.price)
      })
      const total = state.cart.reduce((sum, item) => sum + item.quantity * item.price, 0)
      q('cart-view').textContent = lines.join('\n') + '\n----------------\nTotal: ' + money(total)
    }

    function renderDelivery(order) {
      if (!order) {
        q('delivery-view').textContent = 'Aucune commande active.'
        return
      }

      const status = order.status || 'PENDING'
      const currentIndex = deliveryFlow.indexOf(status)
      const steps = deliveryFlow.map((step, index) => {
        let cls = 'step'
        if (index < currentIndex) {
          cls += ' done'
        }
        if (index === currentIndex) {
          cls += ' now'
        }
        return '<div class="' + cls + '">' + step + '</div>'
      }).join('')

      q('delivery-view').innerHTML =
        '<div><strong>Commande #' + order.id + '</strong></div>' +
        '<div>Statut courant: ' + status + '</div>' +
        '<div class="steps">' + steps + '</div>'
    }

    function addProductToCart(productId, quantity) {
      const product = state.shopProducts.find(item => Number(item.id) === Number(productId))
      if (!product) {
        addTimeline(false, 'Panier', 'Produit introuvable')
        return
      }

      const safeQty = Number(quantity) > 0 ? Number(quantity) : 1
      const existing = state.cart.find(item => Number(item.id) === Number(product.id))
      if (existing) {
        existing.quantity += safeQty
      } else {
        state.cart.push({
          id: product.id,
          name: product.name,
          price: Number(product.price || 0),
          quantity: safeQty
        })
      }

      renderCart()
      addTimeline(true, 'Panier', 'Produit ajoute au panier')
      showOutput({ cart: state.cart })
    }

    function renderShopProducts() {
      const root = q('shop-products')
      if (!state.shopProducts.length) {
        root.innerHTML = '<div class="small">Aucun produit disponible pour le moment.</div>'
        return
      }

      root.innerHTML = state.shopProducts.map(product => {
        return '<article class="product-card">' +
          '<p class="product-title">' + product.name + '</p>' +
          '<p class="product-meta">Prix: ' + money(product.price) + ' | Stock: ' + (product.stock || 0) + '</p>' +
          '<div class="qty-row"><span>Quantite</span><input id="qty-' + product.id + '" type="number" min="1" value="1" /></div>' +
          '<button class="btn add-to-cart" data-id="' + product.id + '">Ajouter au panier</button>' +
        '</article>'
      }).join('')
    }

    async function ensureCustomerSession() {
      if (state.token) {
        return
      }

      randomizeIdentity()
      await runStep('Register (client)', stepRegister)
      await runStep('Login (client)', stepLogin)
    }

    async function loadProductsForShop() {
      markPath([
        ['client', 'api-gateway'],
        ['api-gateway', 'product-service'],
        ['product-service', 'db-products']
      ])

      const response = await apiCall('/api/products/products', { method: 'GET' })
      state.shopProducts = Array.isArray(response) ? response : (response.data || [])
      renderShopProducts()
      addTimeline(true, 'Catalogue', 'Produits charges depuis Product Service')
      showOutput(response)
    }

    async function checkoutFromCart() {
      if (!state.cart.length) {
        throw new Error('Panier vide: ajoute un produit avant de commander')
      }

      await ensureCustomerSession()

      const userId = state.user && state.user.id ? state.user.id : 1
      const payload = {
        userId,
        items: state.cart.map(item => ({
          productId: item.id,
          quantity: item.quantity,
          unitPrice: item.price
        }))
      }

      markPath([
        ['client', 'api-gateway'],
        ['api-gateway', 'order-service'],
        ['order-service', 'db-orders'],
        ['order-service', 'rabbitmq']
      ])

      const order = await apiCall('/api/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + state.token
        },
        body: JSON.stringify(payload)
      })

      state.currentOrder = order
      state.order = order
      state.cart = []
      renderCart()
      renderDelivery(order)
      addTimeline(true, 'Checkout', 'Commande creee et evenement RabbitMQ emis')
      showOutput(order)
      return order
    }

    async function loadMyOrders() {
      await ensureCustomerSession()
      const userId = state.user && state.user.id ? state.user.id : 1

      markPath([
        ['client', 'api-gateway'],
        ['api-gateway', 'order-service'],
        ['order-service', 'db-orders']
      ])

      const orders = await apiCall('/api/orders/user/' + userId, {
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + state.token
        }
      })

      state.userOrders = Array.isArray(orders) ? orders : []
      if (state.userOrders.length) {
        state.currentOrder = state.userOrders[0]
      }
      renderDelivery(state.currentOrder)
      addTimeline(true, 'Mes commandes', 'Historique charge depuis Order Service')
      showOutput(orders)
      return orders
    }

    async function moveDeliveryStatus(nextStatus) {
      await ensureCustomerSession()
      if (!state.currentOrder || !state.currentOrder.id) {
        throw new Error('Aucune commande active pour changer le statut')
      }

      markPath([
        ['client', 'api-gateway'],
        ['api-gateway', 'order-service'],
        ['order-service', 'db-orders']
      ])

      const order = await apiCall('/api/orders/' + state.currentOrder.id + '/status?status=' + nextStatus, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer ' + state.token
        }
      })

      state.currentOrder = order
      renderDelivery(order)
      addTimeline(true, 'Livraison', 'Statut passe a ' + nextStatus)
      showOutput(order)
      return order
    }

    function markPath(paths) {
      document.querySelectorAll('.edge').forEach(edge => edge.classList.remove('active'))
      paths.forEach(path => {
        const selector = '.edge[data-from="' + path[0] + '"][data-to="' + path[1] + '"]'
        document.querySelectorAll(selector).forEach(edge => edge.classList.add('active'))
      })
      setTimeout(() => {
        document.querySelectorAll('.edge').forEach(edge => edge.classList.remove('active'))
      }, 1400)
    }

    async function apiCall(url, options) {
      const response = await fetch(url, options)
      const raw = await response.text()
      let body = raw
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        body = raw
      }
      if (!response.ok) {
        throw new Error('HTTP ' + response.status + ' - ' + (typeof body === 'string' ? body : JSON.stringify(body)))
      }
      return body
    }

    async function stepRegister() {
      const payload = {
        email: q('email').value,
        username: q('username').value,
        password: q('password').value
      }
      markPath([
        ['client', 'api-gateway'],
        ['api-gateway', 'user-service'],
        ['user-service', 'db-users']
      ])
      const user = await apiCall('/api/users/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      state.user = user
      showOutput(user)
      addTimeline(true, 'Register', 'Gateway -> User Service -> DB Users')
      return user
    }

    async function stepLogin() {
      const payload = {
        email: q('email').value,
        password: q('password').value
      }
      markPath([
        ['client', 'api-gateway'],
        ['api-gateway', 'user-service'],
        ['user-service', 'db-users']
      ])
      const token = await apiCall('/api/users/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      state.token = token.access_token
      q('token-preview').textContent = 'Token: ' + state.token
      showOutput(token)
      addTimeline(true, 'Login', 'JWT genere et retourne via Gateway')
      return token
    }

    async function stepCreateProduct() {
      const payload = {
        name: q('product-name').value,
        description: 'Produit cree depuis le dashboard dynamique',
        price: Number(q('product-price').value),
        stock: 10,
        image_url: 'https://example.com/product.png'
      }
      markPath([
        ['client', 'api-gateway'],
        ['api-gateway', 'product-service'],
        ['product-service', 'db-products']
      ])
      const product = await apiCall('/api/products/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      state.product = product
      showOutput(product)
      addTimeline(true, 'Create Product', 'Gateway -> Product Service -> DB Products')
      return product
    }

    async function stepCreateOrder() {
      if (!state.token) {
        throw new Error('Token manquant: executer Login avant Create Order')
      }
      if (!state.product || !state.product.id) {
        throw new Error('Produit manquant: executer Create Product avant Create Order')
      }
      const userId = state.user && state.user.id ? state.user.id : 1
      const quantity = Number(q('order-qty').value)
      const unitPrice = Number(q('product-price').value)

      const payload = {
        userId,
        items: [
          {
            productId: state.product.id,
            quantity,
            unitPrice
          }
        ]
      }

      markPath([
        ['client', 'api-gateway'],
        ['api-gateway', 'order-service'],
        ['order-service', 'db-orders'],
        ['order-service', 'rabbitmq']
      ])
      const order = await apiCall('/api/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + state.token
        },
        body: JSON.stringify(payload)
      })
      state.order = order
      showOutput(order)
      addTimeline(true, 'Create Order', 'Gateway -> Order Service -> DB Orders + RabbitMQ')
      return order
    }

    async function runStep(label, fn) {
      try {
        const result = await fn()
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        addTimeline(false, label, message)
        showOutput(message)
        throw error
      }
    }

    async function runAll() {
      setBusy(true)
      randomizeIdentity()
      try {
        await runStep('Register', stepRegister)
        await runStep('Login', stepLogin)
        await runStep('Create Product', stepCreateProduct)
        await runStep('Create Order', stepCreateOrder)
        addTimeline(true, 'Scenario complet', 'Tous les appels ont reussi')
      } catch {
        addTimeline(false, 'Scenario complet', 'Interrompu suite a une erreur')
      } finally {
        setBusy(false)
      }
    }

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
      q('last-refresh').textContent = 'Derniere mise a jour: ' + date.toLocaleString()
    }

    function renderTopology(topology) {
      const flow = topology.links
        .map(link => link.from + ' -> ' + link.to + ' [' + link.type + ']')
        .join('    |    ')
      q('flow').textContent = flow

      const linksList = q('links-list')
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

    function bindActions() {
      q('btn-register').addEventListener('click', async () => {
        setBusy(true)
        try {
          await runStep('Register', stepRegister)
        } finally {
          setBusy(false)
        }
      })

      q('btn-login').addEventListener('click', async () => {
        setBusy(true)
        try {
          await runStep('Login', stepLogin)
        } finally {
          setBusy(false)
        }
      })

      q('btn-create-product').addEventListener('click', async () => {
        setBusy(true)
        try {
          await runStep('Create Product', stepCreateProduct)
        } finally {
          setBusy(false)
        }
      })

      q('btn-create-order').addEventListener('click', async () => {
        setBusy(true)
        try {
          await runStep('Create Order', stepCreateOrder)
        } finally {
          setBusy(false)
        }
      })

      q('btn-run-all').addEventListener('click', runAll)

      q('btn-load-products').addEventListener('click', async () => {
        setBusy(true)
        try {
          await runStep('Catalogue', loadProductsForShop)
        } finally {
          setBusy(false)
        }
      })

      q('btn-checkout').addEventListener('click', async () => {
        setBusy(true)
        try {
          await runStep('Checkout', checkoutFromCart)
        } finally {
          setBusy(false)
        }
      })

      q('btn-my-orders').addEventListener('click', async () => {
        setBusy(true)
        try {
          await runStep('Mes commandes', loadMyOrders)
        } finally {
          setBusy(false)
        }
      })

      q('btn-status-confirmed').addEventListener('click', async () => {
        setBusy(true)
        try {
          await runStep('Status CONFIRMED', () => moveDeliveryStatus('CONFIRMED'))
        } finally {
          setBusy(false)
        }
      })

      q('btn-status-shipped').addEventListener('click', async () => {
        setBusy(true)
        try {
          await runStep('Status SHIPPED', () => moveDeliveryStatus('SHIPPED'))
        } finally {
          setBusy(false)
        }
      })

      q('btn-status-delivered').addEventListener('click', async () => {
        setBusy(true)
        try {
          await runStep('Status DELIVERED', () => moveDeliveryStatus('DELIVERED'))
        } finally {
          setBusy(false)
        }
      })

      q('shop-products').addEventListener('click', (event) => {
        const target = event.target
        if (!(target instanceof HTMLElement)) {
          return
        }
        if (!target.classList.contains('add-to-cart')) {
          return
        }

        const productId = Number(target.getAttribute('data-id'))
        const qtyInput = q('qty-' + productId)
        const quantity = qtyInput ? Number(qtyInput.value) : 1
        addProductToCart(productId, quantity)
      })
    }

    ;(async function bootstrap() {
      bindActions()
      const topology = await loadTopology()
      renderTopology(topology)
      renderCart()
      renderDelivery(null)
      await loadProductsForShop()
      await refresh()
      setInterval(refresh, 5000)
      addTimeline(true, 'Dashboard pret', 'Mode technique + mode client livraison actifs')
    })()
  </script>
</body>
</html>`
}

// Middleware de sécurité et logging
app.use(helmet())
app.use(cors())
app.use(morgan('combined'))
app.use(express.json())

// Route de santé (health check)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.get('/api/architecture/topology', (req, res) => {
  res.json({
    generatedAt: new Date().toISOString(),
    services: architectureServices,
    links: architectureLinks
  })
})

app.get('/api/architecture/status', async (req, res) => {
  const services = await Promise.all(
    architectureServices.map(async (service) => {
      if (service.healthMode === 'http' && service.healthPath) {
        const health = await checkHttpService(service.url, service.healthPath)
        return {
          ...service,
          ...health
        }
      }

      if (service.healthMode === 'tcp' && service.host && service.port) {
        const health = await checkTcpService(service.host, service.port)
        return {
          ...service,
          ...health
        }
      }

      if (service.healthMode === 'none') {
        return {
          ...service,
          status: 'unknown',
          latencyMs: null,
          endpoint: null
        }
      }

      return {
        ...service,
        status: 'unknown',
        latencyMs: null,
        endpoint: null
      }
    })
  )

  res.json({
    checkedAt: new Date().toISOString(),
    services
  })
})

app.get('/architecture', (req, res) => {
  res.redirect('/')
})

app.get('/admin', (req, res) => {
  res.redirect('/')
})

app.get('/shop', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(shopHtml())
})

app.get('/login', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(shopHtml())
})

app.get('/catalog', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(shopHtml())
})

app.get('/checkout', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(shopHtml())
})

app.get('/orders', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(shopHtml())
})

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(shopHtml())
})

// 🔓 Middleware conditionnel pour exclure le login et le register de la vérification JWT
const userAuthWrapper = (req: any, res: any, next: any) => {
  if (req.path === '/login' || req.path === '/register') {
    return next()
  }
  return authMiddleware(req, res, next)
}

// Proxy vers User Service (port 8001)
app.use('/api/users', userAuthWrapper, createProxyMiddleware({
  target: USER_SERVICE_URL,
  changeOrigin: true,
  pathRewrite: { '^/api/users': '' },
  on: {
    proxyReq: fixRequestBody, // 🎯 AJOUT : pour éviter le timeout sur les POST (Login/Register)
    error: (err, req, res: any) => {
      res.status(503).json({ error: 'User service indisponible' })
    }
  }
}))

// Proxy vers Product Service (port 8002)
app.use('/api/products', createProxyMiddleware({
  target: PRODUCT_SERVICE_URL,
  changeOrigin: true,
  pathRewrite: { '^/api/products': '' },
  on: {
    proxyReq: fixRequestBody, // 🎯 AJOUT : au cas où tu crées un produit en POST plus tard
    error: (err, req, res: any) => {
      res.status(503).json({ error: 'Product service indisponible' })
    }
  }
}))

// Proxy vers Order Service (port 8003)
app.use('/api/orders', authMiddleware, createProxyMiddleware({
  target: ORDER_SERVICE_URL,
  changeOrigin: true,
  pathRewrite: (path: string) => path === '/' ? '/orders' : `/orders${path}`,
  on: {
    proxyReq: fixRequestBody, // 🎯 LA CORRECTION : Ré-injecte le body consommé par Express pour Spring Boot
    error: (err, req, res: any) => {
      res.status(503).json({ error: 'Order service indisponible' })
    }
  }
}))

app.listen(PORT, () => {
  console.log(`🚀 API Gateway démarré sur le port ${PORT}`)
})