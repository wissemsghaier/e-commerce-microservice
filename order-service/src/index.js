import express from "express";
import cors from "cors";

const app = express();
const port = Number(process.env.PORT || 8003);

const USER_SERVICE_URL = process.env.USER_SERVICE_URL || "http://user-service:8001";
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || "http://product-service:8002";

app.use(cors());
app.use(express.json());

let nextOrderId = 1;
const orders = [];

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }
  return response.json();
}

app.get("/health", async (_req, res) => {
  const [userHealth, productHealth] = await Promise.allSettled([
    fetch(USER_SERVICE_URL + "/health"),
    fetch(PRODUCT_SERVICE_URL + "/health")
  ]);

  const usersUp = userHealth.status === "fulfilled" && userHealth.value.ok;
  const productsUp = productHealth.status === "fulfilled" && productHealth.value.ok;

  res.json({
    status: usersUp && productsUp ? "ok" : "degraded",
    service: "order-service",
    dependencies: {
      users: usersUp,
      products: productsUp
    }
  });
});

app.get("/orders", (_req, res) => {
  res.json(orders);
});

app.get("/orders/:id", (req, res) => {
  const id = Number(req.params.id);
  const order = orders.find((item) => item.id === id);
  if (!order) {
    return res.status(404).json({ message: "Order not found" });
  }
  res.json(order);
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

  const order = {
    id: nextOrderId++,
    userId,
    userName: user.name,
    productId,
    productName: product.name,
    price: product.price,
    quantity,
    total,
    status: "CREATED",
    createdAt: new Date().toISOString()
  };

  orders.push(order);
  res.status(201).json(order);
});

app.listen(port, () => {
  console.log("order-service running on port", port);
});
