import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware' // 🎯 AJOUT : fixRequestBody ici
import { authMiddleware } from './middleware/auth'

const app = express()
const PORT = process.env.PORT || 3000

// Middleware de sécurité et logging
app.use(helmet())
app.use(cors())
app.use(morgan('combined'))
app.use(express.json())

// Route de santé (health check)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
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
  target: process.env.USER_SERVICE_URL || 'http://localhost:8001',
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
  target: process.env.PRODUCT_SERVICE_URL || 'http://localhost:8002',
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
  target: process.env.ORDER_SERVICE_URL || 'http://localhost:8003',
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