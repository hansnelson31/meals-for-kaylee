# Small, plain Node image — no build step needed since this is
# just Express + a static HTML page.
FROM node:20-alpine

WORKDIR /app

# Install dependencies first so this layer gets cached between deploys.
COPY package*.json ./
RUN npm install --omit=dev

# Then copy the rest of the app.
COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
