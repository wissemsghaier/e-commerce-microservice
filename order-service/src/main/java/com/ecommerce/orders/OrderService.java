package com.ecommerce.orders;

import lombok.RequiredArgsConstructor;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.stereotype.Service;
import java.math.BigDecimal;
import java.util.List;

@Service @RequiredArgsConstructor
public class OrderService {
    private final OrderRepository orderRepo;
    private final RabbitTemplate rabbitTemplate;

    public Order createOrder(Order order) {
        BigDecimal total = order.getItems().stream()
            .map(i -> i.getUnitPrice().multiply(BigDecimal.valueOf(i.getQuantity())))
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        order.setTotalAmount(total);
        
        Order saved = orderRepo.save(order);
        
        // Publier un événement vers RabbitMQ
        rabbitTemplate.convertAndSend(
            "orders.exchange",
            "order.created",
            "order_id:" + saved.getId()
        );
        return saved;
    }

    public List<Order> getUserOrders(Long userId) {
        return orderRepo.findByUserId(userId);
    }

    public Order updateStatus(Long id, Order.OrderStatus status) {
        Order order = orderRepo.findById(id)
            .orElseThrow(() -> new RuntimeException("Commande introuvable"));
        order.setStatus(status);
        return orderRepo.save(order);
    }
}