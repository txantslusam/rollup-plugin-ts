import {ModuleFormat} from "rollup";
import {PreNormalizedChunk} from "./normalize-chunk";
import {getChunkForModule} from "../../service/transformer/declaration-bundler/util/get-chunk-filename";
import {basename, stripKnownExtension} from "../path/path-util";
import {generateRandomHash} from "../hash/generate-random-hash";
import {SourceFileToDependenciesMap} from "../../service/transformer/declaration-bundler/declaration-bundler-options";
import {CompilerHost} from "../../service/compiler-host/compiler-host";
import {pickResolvedModule} from "../pick-resolved-module";

function createCommonChunk(module: string, code: string, format: ModuleFormat, chunkFileNames = `[name]-[hash].js`): PreNormalizedChunk {
	const name = stripKnownExtension(basename(module));
	const hash = generateRandomHash({key: code});
	return {
		fileName: chunkFileNames
			.replace(/\[format]/g, format)
			.replace(/\[hash]/g, hash)
			.replace(/\[name]/g, name),
		modules: [module],
		isEntry: false
	};
}

function ensureChunkForModule(
	module: string,
	code: string,
	chunks: PreNormalizedChunk[],
	moduleDependencyMap: SourceFileToDependenciesMap,
	format: ModuleFormat,
	chunkFileNames: string | undefined
): PreNormalizedChunk {
	let chunk = getChunkForModule(module, chunks);
	const [firstChunk] = chunks;

	if (chunk == null) {
		if (chunks.length === 1) {
			firstChunk.modules.unshift(module);
			return firstChunk;
		} else {
			// Find all modules that refer to this module.
			const referencingModules = [...moduleDependencyMap.entries()]
				.map(([otherModule, dependencies]) => [otherModule, [...dependencies]] as const)
				.filter(([, dependencies]) => dependencies.find(resolveModule => pickResolvedModule(resolveModule, false) === module))
				.map(([otherModule]) => otherModule);

			// Find all chunks for the referencing modules
			const [firstReferencingChunk, ...otherReferencingChunks] = new Set(
				referencingModules.map(referencingModule => getChunkForModule(referencingModule, chunks)).filter(chunkOrUndefined => chunkOrUndefined != null)
			);

			// If only 1 chunk is matched, use that one
			if (firstReferencingChunk != null && otherReferencingChunks.length === 0) {
				firstReferencingChunk.modules.unshift(module);
				return firstReferencingChunk;
			}

			// Otherwise, create a new chunk
			else {
				chunk = createCommonChunk(module, code, format, chunkFileNames);
				chunks.push(chunk);
				return chunk;
			}
		}
	} else {
		return chunk;
	}
}

export function mergeChunksWithAmbientDependencies(chunks: PreNormalizedChunk[], host: CompilerHost, format: ModuleFormat = "esm", chunkFileNames: string | undefined): void {
	const dependencyToModulesMap: Map<string, Set<string>> = new Map();
	const sourceFileToDependenciesMap = host.getAllDependencies();

	for (const [module, dependencies] of sourceFileToDependenciesMap.entries()) {
		for (const resolvedModule of dependencies) {
			const dependency = pickResolvedModule(resolvedModule, false);
			if (dependency == null) continue;
			let modulesForDependency = dependencyToModulesMap.get(dependency);
			if (modulesForDependency == null) {
				modulesForDependency = new Set();
				dependencyToModulesMap.set(dependency, modulesForDependency);
			}
			modulesForDependency.add(module);
		}
	}

	for (const [dependency, modulesForDependency] of dependencyToModulesMap.entries()) {
		const text = host.readFile(dependency);
		if (text == null) continue;
		const chunkWithDependency = ensureChunkForModule(dependency, text, chunks, sourceFileToDependenciesMap, format, chunkFileNames);

		const chunksForModulesForDependency = new Set<PreNormalizedChunk>(
			[...modulesForDependency].map(moduleForDependency => ensureChunkForModule(moduleForDependency, text, chunks, sourceFileToDependenciesMap, format, chunkFileNames))
		);

		// If the modules that refer to the dependency are divided across multiple chunks, and one of those chunks contain the dependency,
		// move it into its own chunk
		if (chunksForModulesForDependency.size > 1) {
			const containingChunk = [...chunksForModulesForDependency].find(chunkForModuleDependency => chunkForModuleDependency === chunkWithDependency);
			if (containingChunk != null) {
				containingChunk.modules.splice(containingChunk.modules.indexOf(dependency), 1);
				chunks.push(createCommonChunk(dependency, text, format, chunkFileNames));
			}
		}
	}
}
