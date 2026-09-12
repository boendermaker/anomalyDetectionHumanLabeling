# Wir nutzen Node 22 LTS auf Debian Bookworm (stabil für native Module)
FROM node:22-bookworm-slim

# Installiere notwendige Build-Tools für native C++ Bindings
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Arbeitsverzeichnis im Container
WORKDIR /usr/src/app

# Kopiere package.json zuerst (für effizientes Caching der Layer)
COPY package*.json ./

# Installiere Abhängigkeiten
RUN npm install

# Kopiere den Rest des Quellcodes
COPY . .

# Startbefehl
CMD ["node", "index.js"]