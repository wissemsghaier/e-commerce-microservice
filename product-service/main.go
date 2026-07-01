package main

import (
    "product-service/database"
    "product-service/handlers"
    "github.com/gin-gonic/gin"
)

func main() {
    database.Connect()
    
    r := gin.Default()
    
    r.GET("/health", func(c *gin.Context) {
        c.JSON(200, gin.H{"status": "ok"})
    })
    r.HEAD("/health", func(c *gin.Context) {
        c.Status(200)
    })
    
    v1 := r.Group("/products")
    {
        v1.GET("/", handlers.GetProducts)
        v1.GET("/:id", handlers.GetProduct)
        v1.POST("/", handlers.CreateProduct)
        v1.PUT("/:id", handlers.UpdateProduct)
        v1.DELETE("/:id", handlers.DeleteProduct)
    }
    
    r.Run(":8002")
}
