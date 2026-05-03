FROM nginx:alpine

# Remove default config
RUN rm /etc/nginx/conf.d/default.conf

# Create directory for SSL certificates (to be mounted via EFS)
RUN mkdir -p /etc/nginx/ssl

# Copy our master configuration
COPY nginx.conf /etc/nginx/conf.d/herald-proxy.conf

# Expose HTTP and HTTPS
EXPOSE 80 443

CMD ["nginx", "-g", "daemon off;"]
