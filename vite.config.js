import {defineConfig} from 'vite';

export default defineConfig({
  root:'web',
  esbuild:{jsx:'automatic'},
  build:{outDir:'dist',emptyOutDir:true},
  server:{proxy:{'/admin':'http://localhost:8080','/v1':'http://localhost:8080','/health':'http://localhost:8080'}},
});
