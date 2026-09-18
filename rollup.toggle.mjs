import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

// Bundles the CLI (and the Kasa controller + tplink-smarthome-api) into a single
// self-contained ESM file that runs on any modern Node — including the system
// Node 20 the desktop shortcuts use, which can't execute TypeScript directly.
export default {
	input: "scripts/toggle.ts",
	output: {
		file: "dist/kasa-toggle.mjs",
		format: "esm",
		inlineDynamicImports: true,
	},
	plugins: [
		typescript({
			include: ["src/**/*.ts", "scripts/**/*.ts"],
			compilerOptions: { declaration: false, declarationMap: false },
		}),
		nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
		commonjs(),
	],
};
