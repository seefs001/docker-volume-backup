FROM oven/bun:latest

WORKDIR /app

# Copy package.json and install dependencies
COPY package.json bun.lockb ./
RUN bun install

# Copy the rest of the application
COPY . .

# Create backup directory
RUN mkdir -p volume-backup

CMD ["bun", "run", "index.ts"]