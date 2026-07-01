FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY go.mod ./
RUN go mod download

COPY main.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o product-service main.go

FROM alpine:3.20

WORKDIR /app
RUN apk add --no-cache wget
COPY --from=builder /app/product-service ./product-service

EXPOSE 8002

CMD ["./product-service"]
