# Étape 1 : compilation avec Maven
FROM maven:3.9-eclipse-temurin-21 AS builder

WORKDIR /app

COPY pom.xml .
RUN mvn dependency:go-offline -B

COPY src ./src
RUN mvn clean package -DskipTests

# Étape 2 : image finale, légère
FROM eclipse-temurin:21-jre-alpine

WORKDIR /app
RUN apk add --no-cache wget
COPY --from=builder /app/target/*.jar app.jar

EXPOSE 8003

CMD ["java", "-jar", "app.jar"]