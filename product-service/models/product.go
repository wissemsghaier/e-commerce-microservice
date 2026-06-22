package models

import (
    "time"
    "gorm.io/gorm"
)

type Product struct {
    ID          uint           `json:"id" gorm:"primaryKey"`
    Name        string         `json:"name" gorm:"not null"`
    Description string         `json:"description"`
    Price       float64        `json:"price" gorm:"not null"`
    Stock       int            `json:"stock" gorm:"default:0"`
    CategoryID  *uint           `json:"category_id"`
    ImageURL    string         `json:"image_url"`
    CreatedAt   time.Time      `json:"created_at"`
    DeletedAt   gorm.DeletedAt `json:"-" gorm:"index"`
}

type Category struct {
    ID       uint      `json:"id" gorm:"primaryKey"`
    Name     string    `json:"name" gorm:"not null;unique"`
    Products []Product `json:"products,omitempty"`
}
