FROM apify/actor-node-playwright-chrome:20

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY src ./src
COPY input_schema.json ./

# Run the actor
CMD ["node", "src/main.js"]
