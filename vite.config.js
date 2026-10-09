import { resolve } from 'node:path';

// Multi-page app: both the classroom game and the teacher panel are top-level
// pages. Without explicit `input`, Vite only builds index.html and the admin
// panel silently goes missing from the deployment.
export default {
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin.html'),
      },
    },
  },
};
