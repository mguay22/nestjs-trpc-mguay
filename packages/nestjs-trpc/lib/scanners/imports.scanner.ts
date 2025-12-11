import { Injectable } from '@nestjs/common';
import { Project, SourceFile } from 'ts-morph';
import { SourceFileImportsMap } from '../interfaces/generator.interface';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

@Injectable()
export class ImportsScanner {
  public buildSourceFileImportsMap(
    sourceFile: SourceFile,
    project: Project,
  ): Map<string, SourceFileImportsMap> {
    const sourceFileImportsMap = new Map<string, SourceFileImportsMap>();
    const importDeclarations = sourceFile.getImportDeclarations();

    for (const importDeclaration of importDeclarations) {
      const namedImports = importDeclaration.getNamedImports();
      console.error(
        `Processing import declaration: ${importDeclaration.getText()}`,
      );
      for (const namedImport of namedImports) {
        const name = namedImport.getName();
        console.error(`Processing named import: ${name}`);
        let importedSourceFile =
          importDeclaration.getModuleSpecifierSourceFile();

        console.error(
          `Imported source file: ${importedSourceFile?.getFilePath()}`,
        );

        // If it resolved to a .d.ts file, try to find the TypeScript source instead
        if (
          importedSourceFile &&
          importedSourceFile.getFilePath().endsWith('.d.ts')
        ) {
          console.error(
            `Detected .d.ts file, trying to find TypeScript source...`,
          );
          const tsSourcePath = this.findTypeScriptSource(
            importedSourceFile.getFilePath(),
          );
          console.error(`TypeScript source path: ${tsSourcePath}`);

          if (tsSourcePath) {
            const tsSourceFile =
              project.addSourceFileAtPathIfExists(tsSourcePath);
            if (tsSourceFile) {
              console.error(
                `✓ Replaced .d.ts with TypeScript source: ${tsSourcePath}`,
              );
              importedSourceFile = tsSourceFile;
            } else {
              console.error(
                `✗ Could not add TypeScript source file: ${tsSourcePath}`,
              );
            }
          }
        }

        if (importedSourceFile == null) {
          // Try to resolve using Node's module resolution
          const moduleSpecifier = importDeclaration.getModuleSpecifierValue();
          console.error(
            `Trying to resolve module specifier: ${moduleSpecifier}`,
          );
          const resolvedPath = this.resolveModuleUsingNode(
            moduleSpecifier,
            sourceFile.getFilePath(),
          );
          console.error(`Resolved path: ${resolvedPath}`);

          if (resolvedPath) {
            // Add the resolved file to the project and try again
            importedSourceFile =
              project.addSourceFileAtPathIfExists(resolvedPath);
            console.error(
              `Imported source file after resolution: ${importedSourceFile?.getFilePath()}`,
            );
          }

          if (importedSourceFile == null) {
            console.error(
              `Could not resolve imported source file for ${name} from ${importDeclaration.getModuleSpecifierValue()}`,
            );
            continue;
          }
        }

        const resolvedSourceFile =
          importedSourceFile.getFilePath().endsWith('index.ts') &&
          !importedSourceFile.getVariableDeclaration(name)
            ? this.resolveBarrelFileImport(importedSourceFile, name, project)
            : importedSourceFile;

        console.error(
          `Resolved source file: ${resolvedSourceFile?.getFilePath()}`,
        );

        if (resolvedSourceFile == null) {
          console.error(`✗ Resolved source file is null for ${name}`);
          continue;
        }

        // Generalized logic to handle various kinds of declarations
        const declaration =
          resolvedSourceFile.getVariableDeclaration(name) ||
          resolvedSourceFile.getClass(name) ||
          resolvedSourceFile.getInterface(name) ||
          resolvedSourceFile.getEnum(name) ||
          resolvedSourceFile.getFunction(name);

        console.error(
          `Declaration found for ${name}: ${declaration ? 'YES' : 'NO'}`,
        );
        if (declaration) {
          console.error(`Declaration type: ${declaration.constructor.name}`);
        }

        if (declaration != null) {
          const initializer =
            'getInitializer' in declaration
              ? declaration.getInitializer()
              : declaration;
          sourceFileImportsMap.set(name, {
            initializer: initializer ?? declaration,
            sourceFile: resolvedSourceFile,
          });
          console.error(`✓ Added ${name} to imports map`);
        } else {
          console.error(
            `✗ No declaration found for ${name} in ${resolvedSourceFile.getFilePath()}`,
          );
        }
      }
    }

    return sourceFileImportsMap;
  }

  /**
   * https://github.com/dsherret/ts-morph/issues/327
   * Note that if the module resolution of the compiler is Classic then it won't resolve those implicit index.ts module specifiers.
   * So for example, if the moduleResolution compiler option isn't explicitly set then setting the module
   * compiler option to anything but ModuleKind.CommonJS will cause the module resolution kind to resolve to Classic.
   * Additionally, if moduleResolution and the module compiler option isn't set,
   * then a script target of ES2015 and above will also use Classic module resolution.
   */
  private resolveBarrelFileImport(
    barrelSourceFile: SourceFile,
    name: string,
    project: Project,
  ): SourceFile | undefined {
    // Traverse through export declarations to find the actual source of the named import
    for (const exportDeclaration of barrelSourceFile.getExportDeclarations()) {
      const exportedSourceFile =
        exportDeclaration.getModuleSpecifierSourceFile();
      if (exportedSourceFile == null) continue;

      // Check if the named export is explicitly re-exported
      const namedExports = exportDeclaration.getNamedExports();
      if (namedExports.length > 0) {
        const matchingExport = namedExports.find((e) => e.getName() === name);
        if (matchingExport) {
          return exportedSourceFile;
        }
      } else {
        // Handle `export * from ...` case: recursively resolve the export
        const schemaVariable = exportedSourceFile.getVariableDeclaration(name);
        if (schemaVariable) {
          return exportedSourceFile;
        } else {
          // Continue resolving if it's another barrel file
          const baseSourceFile = this.resolveBarrelFileImport(
            exportedSourceFile,
            name,
            project,
          );
          if (baseSourceFile) return baseSourceFile;
        }
      }
    }

    return undefined;
  }

  private resolveModuleUsingNode(
    moduleSpecifier: string,
    fromFile: string,
  ): string | undefined {
    console.error(
      `[resolveModuleUsingNode] Starting resolution for: ${moduleSpecifier}`,
    );
    console.error(`[resolveModuleUsingNode] From file: ${fromFile}`);

    // Only try to resolve non-relative imports (workspace packages, node_modules, etc.)
    if (moduleSpecifier.startsWith('.') || moduleSpecifier.startsWith('/')) {
      console.error(
        `[resolveModuleUsingNode] Skipping relative/absolute import: ${moduleSpecifier}`,
      );
      return undefined;
    }

    try {
      const require = createRequire(fromFile);
      const resolvedPath = require.resolve(moduleSpecifier);
      console.error(
        `[resolveModuleUsingNode] Node resolved to: ${resolvedPath}`,
      );

      // Try to find the TypeScript source file instead of compiled output
      const tsSourcePath = this.findTypeScriptSource(resolvedPath);
      console.error(
        `[resolveModuleUsingNode] findTypeScriptSource returned: ${tsSourcePath}`,
      );

      if (tsSourcePath && fs.existsSync(tsSourcePath)) {
        console.error(
          `[resolveModuleUsingNode] ✓ Found TypeScript source: ${tsSourcePath}`,
        );
        return tsSourcePath;
      }

      // Fallback: Convert .js/.d.ts to .ts if possible
      const tsPath = resolvedPath
        .replace(/\.js$/, '.ts')
        .replace(/\.d\.ts$/, '.ts');
      console.error(`[resolveModuleUsingNode] Trying fallback path: ${tsPath}`);

      if (fs.existsSync(tsPath)) {
        console.error(
          `[resolveModuleUsingNode] ✓ Fallback path exists: ${tsPath}`,
        );
        return tsPath;
      }

      console.error(
        `[resolveModuleUsingNode] ✗ Could not find TypeScript source for: ${moduleSpecifier}`,
      );
      return undefined;
    } catch (error) {
      console.error(
        `[resolveModuleUsingNode] ✗ Error resolving ${moduleSpecifier}:`,
        error,
      );
      return undefined;
    }
  }

  private findTypeScriptSource(compiledPath: string): string | undefined {
    console.error(
      `[findTypeScriptSource] Looking for TS source for: ${compiledPath}`,
    );

    // If it's a .d.ts file in dist/, try to find the source in src/
    // Example: /path/to/package/dist/index.d.ts -> /path/to/package/src/index.ts
    if (compiledPath.includes('/dist/')) {
      const srcPath = compiledPath
        .replace('/dist/', '/src/')
        .replace(/\.d\.ts$/, '.ts')
        .replace(/\.js$/, '.ts');

      console.error(
        `[findTypeScriptSource] Trying dist->src replacement: ${srcPath}`,
      );
      if (fs.existsSync(srcPath)) {
        console.error(
          `[findTypeScriptSource] ✓ Found via dist->src: ${srcPath}`,
        );
        return srcPath;
      }
      console.error(`[findTypeScriptSource] ✗ dist->src path doesn't exist`);
    }

    // Try other common patterns: lib/, build/, out/
    const patterns = ['/lib/', '/build/', '/out/'];
    for (const pattern of patterns) {
      if (compiledPath.includes(pattern)) {
        const srcPath = compiledPath
          .replace(pattern, '/src/')
          .replace(/\.d\.ts$/, '.ts')
          .replace(/\.js$/, '.ts');

        console.error(
          `[findTypeScriptSource] Trying ${pattern}->src replacement: ${srcPath}`,
        );
        if (fs.existsSync(srcPath)) {
          console.error(
            `[findTypeScriptSource] ✓ Found via ${pattern}->src: ${srcPath}`,
          );
          return srcPath;
        }
        console.error(
          `[findTypeScriptSource] ✗ ${pattern}->src path doesn't exist`,
        );
      }
    }

    // Try to find package.json and read the source location
    const packageDir = this.findPackageDirectory(compiledPath);
    console.error(`[findTypeScriptSource] Package directory: ${packageDir}`);

    if (packageDir) {
      const packageJsonPath = path.join(packageDir, 'package.json');
      console.error(
        `[findTypeScriptSource] Looking for package.json at: ${packageJsonPath}`,
      );

      if (fs.existsSync(packageJsonPath)) {
        try {
          const packageJson = JSON.parse(
            fs.readFileSync(packageJsonPath, 'utf8'),
          );
          console.error(
            `[findTypeScriptSource] package.json contents:`,
            JSON.stringify(packageJson, null, 2),
          );

          // Try common source field patterns
          const sourceFields = [
            'source',
            'typescript:main',
            'typings',
            'types',
          ];
          for (const field of sourceFields) {
            if (packageJson[field]) {
              const sourcePath = path.join(packageDir, packageJson[field]);
              console.error(
                `[findTypeScriptSource] Trying field "${field}": ${sourcePath}`,
              );
              if (fs.existsSync(sourcePath) && sourcePath.endsWith('.ts')) {
                console.error(
                  `[findTypeScriptSource] ✓ Found via package.json field "${field}": ${sourcePath}`,
                );
                return sourcePath;
              }
              console.error(
                `[findTypeScriptSource] ✗ Field "${field}" path doesn't exist or isn't .ts`,
              );
            }
          }

          // Fallback: try src/index.ts
          const srcIndexPath = path.join(packageDir, 'src', 'index.ts');
          console.error(
            `[findTypeScriptSource] Trying fallback src/index.ts: ${srcIndexPath}`,
          );
          if (fs.existsSync(srcIndexPath)) {
            console.error(
              `[findTypeScriptSource] ✓ Found via src/index.ts fallback: ${srcIndexPath}`,
            );
            return srcIndexPath;
          }
          console.error(
            `[findTypeScriptSource] ✗ src/index.ts fallback doesn't exist`,
          );
        } catch (error) {
          console.error(
            `[findTypeScriptSource] ✗ Failed to read package.json:`,
            error,
          );
        }
      } else {
        console.error(
          `[findTypeScriptSource] ✗ package.json doesn't exist at ${packageJsonPath}`,
        );
      }
    }

    console.error(
      `[findTypeScriptSource] ✗ All strategies failed for: ${compiledPath}`,
    );
    return undefined;
  }

  private findPackageDirectory(filePath: string): string | undefined {
    let currentDir = path.dirname(filePath);
    const root = path.parse(currentDir).root;

    while (currentDir !== root) {
      const packageJsonPath = path.join(currentDir, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        return currentDir;
      }
      currentDir = path.dirname(currentDir);
    }

    return undefined;
  }
}
