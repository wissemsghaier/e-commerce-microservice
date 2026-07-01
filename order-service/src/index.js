import express from "express";
import cors from "cors";
import pg from "pg";

const app = express();
const port = Number(process.env.PORT || 8003);

const USER_SERVICE_URL = process.env.USER_SERVICE_URL || "http://user-service:8001";
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || "http://product-service:8002";
const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:password@db-orders:5432/orders_db";

const { Pool } = pg;
const db = new Pool({ connectionString: DATABASE_URL });

app.use(cors());
app.use(express.json());

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      user_name TEXT NOT NULL,
      product_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      price NUMERIC(10, 2) NOT NULL,
      quantity INTEGER NOT NULL,
      total NUMERIC(10, 2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'CREATED',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function normalizeOrder(row) {
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    productId: row.product_id,
    productName: row.product_name,
    price: Number(row.price),
    quantity: row.quantity,
    total: Number(row.total),
    status: row.status,
    createdAt: row.created_at
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }
  return response.json();
}

app.get("/health", async (_req, res) => {
  const [userHealth, productHealth, dbHealth] = await Promise.allSettled([
    fetch(USER_SERVICE_URL + "/health"),
    fetch(PRODUCT_SERVICE_URL + "/health"),
    db.query("SELECT 1")
  ]);

  const usersUp = userHealth.status === "fulfilled" && userHealth.value.ok;
  const productsUp = productHealth.status === "fulfilled" && productHealth.value.ok;
  const dbUp = dbHealth.status === "fulfilled";

  const healthy = usersUp && productsUp && dbUp;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    service: "order-service",
    language: "node",
    dependencies: {
      users: usersUp,
      products: productsUp,
      db: dbUp
    }
  });
});

app.get("/orders", async (_req, res) => {
  try {
    const result = await db.query(
      "SELECT id, user_id, user_name, product_id, product_name, price, quantity, total, status, created_at FROM orders ORDER BY id"
    );
    res.json(result.rows.map(normalizeOrder));
  } catch (_error) {
    res.status(500).json({ message: "Database error" });
  }
});

app.get("/orders/:id", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const result = await db.query(
      "SELECT id, user_id, user_name, product_id, product_name, price, quantity, total, status, created_at FROM orders WHERE id = $1",
      [id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ message: "Order not found" });
    }
    res.json(normalizeOrder(result.rows[0]));
  } catch (_error) {
    res.status(500).json({ message: "Database error" });
  }
});

app.post("/orders", async (req, res) => {
  const userId = Number(req.body?.userId);
  const productId = Number(req.body?.productId);
  const quantity = Number(req.body?.quantity || 1);

  if (!userId || !productId || Number.isNaN(quantity) || quantity <= 0) {
    return res.status(400).json({ message: "userId, productId and positive quantity are required" });
  }

  const [user, product] = await Promise.all([
    fetchJson(USER_SERVICE_URL + "/users/" + userId),
    fetchJson(PRODUCT_SERVICE_URL + "/products/" + productId)
  ]);

  if (!user) {
    return res.status(400).json({ message: "Invalid userId" });
  }

  if (!product) {
    return res.status(400).json({ message: "Invalid productId" });
  }

  const total = Number((product.price * quantity).toFixed(2));

  try {
    const result = await db.query(
      `
      INSERT INTO orders(user_id, user_name, product_id, product_name, price, quantity, total, status)
      VALUES($1, $2, $3, $4, $5, $6, $7, 'CREATED')
      RETURNING id, user_id, user_name, product_id, product_name, price, quantity, total, status, created_at
      `,
      [userId, user.name, productId, product.name, product.price, quantity, total]
    );

    res.status(201).json(normalizeOrder(result.rows[0]));
  } catch (_error) {
    res.status(500).json({ message: "Database error" });
  }
});

initDb()
  .then(() => {
    app.listen(port, () => {
      console.log("order-service running on port", port);
    });
  })
  .catch((error) => {
    console.error("Database init failed", error);
    process.exit(1);
  });
