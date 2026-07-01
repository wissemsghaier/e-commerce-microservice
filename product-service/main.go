package main

import (
    "database/sql"
    "fmt"
    "net/http"
    "os"
    "strconv"
    "strings"

    "github.com/gin-gonic/gin"
    _ "github.com/lib/pq"
)

type Product struct {
    ID    int     `json:"id"`
    Name  string  `json:"name"`
    Price float64 `json:"price"`
}

type ProductInput struct {
    Name  string  `json:"name"`
    Price float64 `json:"price"`
}

var db *sql.DB

func initDB() error {
    dsn := os.Getenv("DATABASE_URL")
    if dsn == "" {
        dsn = "postgres://postgres:password@db-products:5432/products_db?sslmode=disable"
    }

    conn, err := sql.Open("postgres", dsn)
    if err != nil {
        return err
    }

    if err := conn.Ping(); err != nil {
        return err
    }

    _, err = conn.Exec(`
        CREATE TABLE IF NOT EXISTS products (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            price DOUBLE PRECISION NOT NULL
        )
    `)
    if err != nil {
        return err
    }

    _, err = conn.Exec(`
        INSERT INTO products(name, price)
        VALUES ('Keyboard', 49.99), ('Mouse', 19.50)
        ON CONFLICT (name) DO NOTHING
    `)
    if err != nil {
        return err
    }

    db = conn
    return nil
}

func main() {
    if err := initDB(); err != nil {
        panic(fmt.Sprintf("database init failed: %v", err))
    }

    router := gin.Default()

    router.GET("/health", func(c *gin.Context) {
        if err := db.Ping(); err != nil {
            c.JSON(http.StatusServiceUnavailable, gin.H{
                "status":   "degraded",
                "service":  "product-service",
                "language": "go",
                "db":       err.Error(),
            })
            return
        }

        c.JSON(http.StatusOK, gin.H{
            "status":   "ok",
            "service":  "product-service",
            "language": "go",
        })
    })

    router.GET("/products", func(c *gin.Context) {
        rows, err := db.Query("SELECT id, name, price FROM products ORDER BY id")
        if err != nil {
            c.JSON(http.StatusInternalServerError, gin.H{"message": "Database error"})
            return
        }
        defer rows.Close()

        products := []Product{}
        for rows.Next() {
            var p Product
            if err := rows.Scan(&p.ID, &p.Name, &p.Price); err != nil {
                c.JSON(http.StatusInternalServerError, gin.H{"message": "Database scan error"})
                return
            }
            products = append(products, p)
        }

        c.JSON(http.StatusOK, products)
    })

    router.GET("/products/:id", func(c *gin.Context) {
        id, err := strconv.Atoi(c.Param("id"))
        if err != nil {
            c.JSON(http.StatusBadRequest, gin.H{"message": "Invalid product id"})
            return
        }

        var p Product
        err = db.QueryRow("SELECT id, name, price FROM products WHERE id = $1", id).Scan(&p.ID, &p.Name, &p.Price)
        if err == sql.ErrNoRows {
            c.JSON(http.StatusNotFound, gin.H{"message": "Product not found"})
            return
        }
        if err != nil {
            c.JSON(http.StatusInternalServerError, gin.H{"message": "Database error"})
            return
        }

        c.JSON(http.StatusOK, p)
    })

    router.POST("/products", func(c *gin.Context) {
        var input ProductInput
        if err := c.ShouldBindJSON(&input); err != nil {
            c.JSON(http.StatusBadRequest, gin.H{"message": "Invalid payload"})
            return
        }

        name := strings.TrimSpace(input.Name)
        if name == "" || input.Price <= 0 {
            c.JSON(http.StatusBadRequest, gin.H{"message": "valid name and positive price are required"})
            return
        }

        var p Product
        err := db.QueryRow(
            "INSERT INTO products(name, price) VALUES ($1, $2) RETURNING id, name, price",
            name,
            input.Price,
        ).Scan(&p.ID, &p.Name, &p.Price)
        if err != nil {
            c.JSON(http.StatusConflict, gin.H{"message": "Product name already exists"})
            return
        }

        c.JSON(http.StatusCreated, p)
    })

    router.Run(":8002")
}
