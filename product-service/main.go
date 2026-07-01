package main

import (
    "net/http"
    "strconv"
    "strings"

    "github.com/gin-gonic/gin"
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

func main() {
    products := []Product{
        {ID: 1, Name: "Keyboard", Price: 49.99},
        {ID: 2, Name: "Mouse", Price: 19.50},
    }
    nextID := 3

    router := gin.Default()

    router.GET("/health", func(c *gin.Context) {
        c.JSON(http.StatusOK, gin.H{
            "status":   "ok",
            "service":  "product-service",
            "language": "go",
        })
    })

    router.GET("/products", func(c *gin.Context) {
        c.JSON(http.StatusOK, products)
    })

    router.GET("/products/:id", func(c *gin.Context) {
        id, err := strconv.Atoi(c.Param("id"))
        if err != nil {
            c.JSON(http.StatusBadRequest, gin.H{"message": "Invalid product id"})
            return
        }

        for _, p := range products {
            if p.ID == id {
                c.JSON(http.StatusOK, p)
                return
            }
        }

        c.JSON(http.StatusNotFound, gin.H{"message": "Product not found"})
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

        p := Product{ID: nextID, Name: name, Price: input.Price}
        nextID++
        products = append(products, p)

        c.JSON(http.StatusCreated, p)
    })

    router.Run(":8002")
}
