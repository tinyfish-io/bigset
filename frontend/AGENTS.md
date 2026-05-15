# Frontend — Agent Guidelines

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

Do not add API routes here. All backend logic lives in `backend/`.

Auth flows use `better-auth/react` client — not Next.js server actions, not middleware auth checks. The frontend is a thin client.
