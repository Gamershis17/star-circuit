# Star Circuit — production image
FROM node:20-alpine

WORKDIR /app

# Install dependencies first (cached unless package.json changes)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy the rest of the app
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
