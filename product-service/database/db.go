package database

import (
    "os"
    "gorm.io/driver/postgres"
    "gorm.io/gorm"
    "product-service/models"
)

var DB *gorm.DB

func Connect() {
    dsn := os.Getenv("DATABASE_URL")
    if dsn == "" {
        // Le sslmode=disable est optionnel ici si GORM gère le fallback, mais fortement conseillé
        dsn = "host=localhost user=postgres password=password dbname=products_db port=5433 sslmode=disable"
    }
    db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
    if err != nil {
        panic("Impossible de connecter PostgreSQL: " + err.Error())
    }
    
    // 🟢 CORRECTION : On migre Category en premier !
    db.AutoMigrate(&models.Category{}, &models.Product{})
    
    DB = db
}