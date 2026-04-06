# AuthenX Server
FROM node:22-alpine

LABEL maintainer="AuthenX Platform"
LABEL description="AuthenX — Academic Credential Verification Server"

WORKDIR /app

# Copy only what's needed (no node_modules — zero deps!)
COPY authenx-node/src/ ./src/
COPY authenx-node/aes_key.json* ./
COPY authenx-node/connector_key.json* ./

# Create data directory
RUN mkdir -p /app/data /app/logs

# Environment
ENV NODE_ENV=production
ENV PORT=3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const http=require('http');const r=http.get('http://localhost:3000/health',res=>{process.exit(res.statusCode===200?0:1)});r.on('error',()=>process.exit(1));r.setTimeout(3000,()=>process.exit(1));"

EXPOSE 3000

CMD ["node", "src/server.js"]
