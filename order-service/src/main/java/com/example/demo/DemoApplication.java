package com.example.demo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.domain.EntityScan;
import org.springframework.context.annotation.ComponentScan;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;

@SpringBootApplication
// 🎯 Force Spring à scanner ton package de contrôleurs et services
@ComponentScan(basePackages = {"com.example.demo", "com.ecommerce.orders"})
// 🎯 Force Spring à scanner tes interfaces de base de données (Repositories)
@EnableJpaRepositories(basePackages = "com.ecommerce.orders")
// 🎯 Force Spring à scanner tes classes de tables de base de données (@Entity)
@EntityScan(basePackages = "com.ecommerce.orders")
public class DemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(DemoApplication.class, args);
    }

}
