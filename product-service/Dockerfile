# Étape 1 : compilation (Mis à jour en 1.25)
FROM golang:1.25-alpine AS builder

WORKDIR /app

COPY go.mod go.sum* ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o product-service main.go

# Étape 2 : image finale, légère
FROM alpine:3.19

WORKDIR /app
COPY --from=builder /app/product-service .

EXPOSE 8002

CMD ["./product-service"]