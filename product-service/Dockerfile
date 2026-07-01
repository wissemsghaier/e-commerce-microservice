FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY go.mod ./
COPY main.go ./
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux go build -mod=mod -o product-service main.go

FROM alpine:3.20

WORKDIR /app
RUN apk add --no-cache wget
COPY --from=builder /app/product-service ./product-service

EXPOSE 8002

CMD ["./product-service"]
