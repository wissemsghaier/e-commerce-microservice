package handlers

import (
    "net/http"
    "strconv"
    "github.com/gin-gonic/gin"
    "product-service/database"
    "product-service/models"
)

func GetProducts(c *gin.Context) {
    var products []models.Product
    query := database.DB
    
    // Filtrer par catégorie si fourni
    if cat := c.Query("category"); cat != "" {
        query = query.Where("category_id = ?", cat)
    }
    
    query.Find(&products)
    c.JSON(http.StatusOK, gin.H{
        "data": products,
        "total": len(products),
    })
}

func GetProduct(c *gin.Context) {
    id, _ := strconv.Atoi(c.Param("id"))
    var product models.Product
    result := database.DB.First(&product, id)
    if result.Error != nil {
        c.JSON(http.StatusNotFound, gin.H{"error": "Produit introuvable"})
        return
    }
    c.JSON(http.StatusOK, product)
}

func CreateProduct(c *gin.Context) {
    var product models.Product
    if err := c.ShouldBindJSON(&product); err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
        return
    }
    // 🟢 Ce qu'il faut mettre à la place :
if err := database.DB.Create(&product).Error; err != nil {
    // Si la base de données refuse l'insertion, on renvoie une erreur 400 ou 500
    c.JSON(http.StatusBadRequest, gin.H{
        "status":  "error",
        "message": "Impossible de créer le produit en base de données",
        "details": err.Error(),
    })
    return // Crucial : on arrête la fonction ici pour ne pas envoyer le faux 201 !
}

// Si on arrive ici, l'insertion a réussi pour de vrai
c.JSON(http.StatusCreated, product)
}

func UpdateProduct(c *gin.Context) {
    id, _ := strconv.Atoi(c.Param("id"))
    var product models.Product
    if database.DB.First(&product, id).Error != nil {
        c.JSON(http.StatusNotFound, gin.H{"error": "Introuvable"})
        return
    }
    c.ShouldBindJSON(&product)
    database.DB.Save(&product)
    c.JSON(http.StatusOK, product)
}

func DeleteProduct(c *gin.Context) {
    id, _ := strconv.Atoi(c.Param("id"))
    database.DB.Delete(&models.Product{}, id)
    c.JSON(http.StatusOK, gin.H{"message": "Produit supprimé"})
}
