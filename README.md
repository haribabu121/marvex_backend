# Marvex Energy CMS API

The CMS API is a separate Express service backed by MongoDB and Cloudinary. It serves the single-admin website CMS at `/api/cms`; employee management and employee analytics are not part of this service.

## Local setup

1. Use Node.js 20.19 or newer.
2. From `Backend`, install dependencies with `npm install`.
3. Copy `.env.example` to `.env` (in PowerShell: `Copy-Item .env.example .env`). Replace every placeholder with your own values before starting the API:
   - `MONGODB_URI`: MongoDB Atlas connection string; URL-encode special characters in the username or password, and allow the backend host in Atlas network access.
   - `FRONTEND_URL`: the exact frontend origin, such as `http://localhost:5173`.
   - `TRUST_PROXY=1` only when the API is behind one trusted reverse proxy; otherwise leave it at `0`.
   - `ADMIN_EMAIL` and `ADMIN_PASSWORD`: the initial administrator credentials. Use a unique password with at least 12 characters.
   - `JWT_ACCESS_SECRET`: a cryptographically random value of at least 32 characters.
   - `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`: required for uploading and managing CMS media.
4. Start the API with `npm run dev`. The example configuration uses port `5000`.
5. Set `VITE_API_URL=http://localhost:5000/api/cms` in the frontend environment and start the Vite app.
6. Open `/cms`, sign in with the initial administrator credentials, and change the temporary password before editing content.

The API seeds the one administrator and initial About-page statistics only when their records do not already exist. It does not reset an existing administrator password from environment variables.

## Production

Set `NODE_ENV=production`, use HTTPS for both the website and API, set `FRONTEND_URL` to the exact website origin, and configure `VITE_API_URL` to the deployed API's `/api/cms` base URL. The API uses credentialed CORS, origin checks, HttpOnly cookies, rate-limited sign-in, and secure cookies in production. Keep `.env` and all deployment secrets out of source control.

Cloudinary uploads are signed by the API and uploaded directly from the browser. The API validates the uploaded resource and only permits cleanup of media in its managed `marvex-energy/` folder. Configure Cloudinary before using the CMS media features.

## CMS routes

- `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/change-password`
- `GET /about/public`, `GET /about`, `PUT /about`
- `GET /carousels/public`; authenticated carousel list/create/update/delete endpoints
- `GET /gallery/public`; authenticated gallery list/create/update/delete endpoints
- Authenticated media signatures, upload completion, media library, and unused-media deletion
- Authenticated dashboard summary and activity log endpoints

Published About statistics, carousel videos, and gallery items are served publicly. If the API is unavailable, the public pages retain their existing fallback content where available.
