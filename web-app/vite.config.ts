import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [tailwindcss()],
	resolve: {
		dedupe: ["@mariozechner/mini-lit", "lit"],
	},
	server: {
		proxy: {
			"/api": {
				target: "http://localhost:3030",
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/api/, ""),
			},
		},
	},
});
