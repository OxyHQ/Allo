# Deploying Allo to DigitalOcean App Platform

This guide explains how to deploy your Allo messaging app to DigitalOcean App Platform.

## Prerequisites

1. DigitalOcean account
2. GitHub repository (code must be pushed to GitHub)
3. Domain name (optional, but recommended)

## Option 1: Deploy Using DigitalOcean Dashboard (Recommended for First Deploy)

### Step 1: Prepare Your Repository

1. Push your code to GitHub if you haven't already:
   ```bash
   git add .
   git commit -m "Prepare for DigitalOcean deployment"
   git push origin main
   ```

### Step 2: Create the App on DigitalOcean

1. Go to [DigitalOcean App Platform](https://cloud.digitalocean.com/apps)
2. Click **Create App**
3. Select your GitHub repository: `YOUR_USERNAME/Allo`
4. Select branch: `main`

### Step 3: Configure Backend Service

1. DigitalOcean will auto-detect your app. Edit the backend component:
   - **Name**: `backend`
   - **Type**: Web Service
   - **Source Directory**: `packages/backend`
   - **Build Command**: `npm install && npm run build`
   - **Run Command**: `npm run start`
   - **HTTP Port**: `8080`
   - **Instance Size**: Basic (512MB RAM, $5/month)

2. Add environment variables (click "Edit" next to Environment Variables):
   ```
   NODE_ENV=production
   PORT=8080
   MONGODB_URI=<your-mongodb-connection-string>
   JWT_SECRET=<generate-a-secure-random-string>
   ```

   Optional variables (if you use these features):
   ```
   OPENAI_API_KEY=<your-openai-api-key>
   FIREBASE_PROJECT_ID=<your-firebase-project-id>
   FIREBASE_PRIVATE_KEY=<your-firebase-private-key>
   FIREBASE_CLIENT_EMAIL=<your-firebase-client-email>
   ```

### Step 4: Configure Frontend Static Site

1. Add a new component:
   - **Type**: Static Site
   - **Name**: `frontend`
   - **Source Directory**: `packages/frontend`
   - **Build Command**: `npm install && npm run build`
   - **Output Directory**: `dist`

2. Add frontend environment variables:
   ```
   EXPO_PUBLIC_API_URL=${backend.PUBLIC_URL}
   EXPO_PUBLIC_SOCKET_URL=${backend.PUBLIC_URL}
   ```

   The `${backend.PUBLIC_URL}` syntax automatically uses the backend URL.

### Step 5: Add MongoDB Database (Optional)

If you don't have an external MongoDB:

1. Click **Add Resource** → **Database**
2. Select **MongoDB**
3. Choose a plan (starting at $15/month)
4. The `MONGODB_URI` will be auto-populated

Or use MongoDB Atlas (free tier available):
- Create cluster at [cloud.mongodb.com](https://cloud.mongodb.com)
- Get connection string and add to backend environment variables

### Step 6: Deploy

1. Click **Create Resources**
2. DigitalOcean will build and deploy your app
3. Wait 5-10 minutes for the first deployment

### Step 7: Get Your App URL

Once deployed:
- Frontend: `https://frontend-xxxxx.ondigitalocean.app`
- Backend: `https://backend-xxxxx.ondigitalocean.app`

You can add a custom domain in the Settings tab.

---

## Option 2: Deploy Using App Spec (Advanced)

### Step 1: Update App Spec

1. Edit [.do/app.yaml](.do/app.yaml):
   - Replace `YOUR_GITHUB_USERNAME/Allo` with your actual GitHub repo
   - Add any custom environment variables

### Step 2: Deploy Using doctl CLI

1. Install doctl:
   ```bash
   # macOS
   brew install doctl

   # Linux
   cd ~
   wget https://github.com/digitalocean/doctl/releases/download/v1.94.0/doctl-1.94.0-linux-amd64.tar.gz
   tar xf ~/doctl-1.94.0-linux-amd64.tar.gz
   sudo mv ~/doctl /usr/local/bin
   ```

2. Authenticate:
   ```bash
   doctl auth init
   ```

3. Create the app:
   ```bash
   doctl apps create --spec .do/app.yaml
   ```

4. Get app ID and monitor deployment:
   ```bash
   doctl apps list
   doctl apps get <app-id>
   ```

---

## Configuration Notes

### Backend Requirements

Your backend needs a health check endpoint. Add this to your Express app:

```typescript
// In packages/backend/server.ts
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});
```

### Environment Variables

Make sure your backend reads from environment variables:

```typescript
const PORT = process.env.PORT || 8080;
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET;
```

### Frontend API Configuration

Your frontend should use the environment variable for API URL:

```typescript
// In packages/frontend
const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8080';
```

### WebSocket/Socket.IO Configuration

For Socket.IO to work on DigitalOcean:

1. Ensure your backend allows CORS:
   ```typescript
   import cors from 'cors';
   app.use(cors({
     origin: process.env.FRONTEND_URL || '*',
     credentials: true
   }));
   ```

2. Configure Socket.IO for production:
   ```typescript
   const io = new Server(server, {
     cors: {
       origin: process.env.FRONTEND_URL || '*',
       credentials: true
     },
     transports: ['websocket', 'polling']
   });
   ```

---

## Scaling & Optimization

### Auto-scaling
- DigitalOcean App Platform auto-scales based on traffic
- Start with 1 instance, scale up as needed
- Configure in the dashboard under "Scaling"

### CDN
- DigitalOcean automatically provides CDN for static sites
- Your frontend will be globally distributed

### Database
- Use connection pooling for MongoDB
- Consider MongoDB Atlas for better scalability
- Enable database indexes for performance

---

## Cost Estimate

- **Backend**: $5-12/month (Basic to Professional plan)
- **Frontend**: $3/month (static site)
- **MongoDB** (if using DO): $15/month or use MongoDB Atlas free tier
- **Total**: $8-30/month depending on configuration

---

## Troubleshooting

### Build Failures

Check build logs:
```bash
doctl apps logs <app-id> --type build
```

Common issues:
- **Missing dependencies**: Make sure all dependencies are in package.json
- **Build command fails**: Test locally first: `npm run build`
- **Workspace issues**: Ensure npm workspaces are properly configured

### Runtime Errors

Check runtime logs:
```bash
doctl apps logs <app-id> --type run
```

### Database Connection Issues

- Verify MONGODB_URI is correctly set
- Check if MongoDB allows connections from DigitalOcean IPs
- Enable trusted sources in MongoDB Atlas

---

## Next Steps

1. Set up custom domain
2. Configure SSL certificate (automatic with custom domain)
3. Set up monitoring and alerts
4. Configure backup strategy for database
5. Implement CI/CD with GitHub Actions

---

## Support

- [DigitalOcean App Platform Docs](https://docs.digitalocean.com/products/app-platform/)
- [DigitalOcean Community](https://www.digitalocean.com/community)
