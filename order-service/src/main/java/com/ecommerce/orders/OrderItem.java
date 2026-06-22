package com.ecommerce.orders;

import jakarta.persistence.*;
import lombok.Data;
import java.math.BigDecimal;

@Entity @Data
public class OrderItem {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    
    @ManyToOne @JoinColumn(name = "order_id")
    private Order order;
    
    private Long productId;
    private Integer quantity;
    private BigDecimal unitPrice;
}