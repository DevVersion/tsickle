/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import * as path from 'path';

import {ModulesManifest} from './modules_manifest';
import {visitNodeWithSynthesizedComments} from './transformer_util';
import * as ts from './typescript';

export interface GoogModuleProcessorHost {
  /**
   * Takes a context (ts.SourceFile.fileName of the current file) and the import URL of an ES6
   * import and generates a googmodule module name for the imported module.
   */
  pathToModuleName(context: string, importPath: string): string;
  /**
   * If we do googmodule processing, we polyfill module.id, since that's
   * part of ES6 modules.  This function determines what the module.id will be
   * for each file.
   */
  fileNameToModuleId(fileName: string): string;
  /** Identifies whether this file is the result of a JS transpilation. */
  isJsTranspilation?: boolean;
  /** Whether the emit targets ES5 or ES6+. */
  es5Mode?: boolean;
  /** expand "import 'foo';" to "import 'foo/index';" if it points to an index file. */
  convertIndexImportShorthand?: boolean;

  options: ts.CompilerOptions;
  host: ts.ModuleResolutionHost;
}

/**
 * Creates a string literal that uses single quotes. Purely cosmetic, but increases fidelity to the
 * existing test suite.
 */
function createSingleQuoteStringLiteral(text: string): ts.StringLiteral {
  const stringLiteral = ts.createLiteral(text);
  // tslint:disable-next-line:no-any accessing TS internal API.
  (stringLiteral as any).singleQuote = true;
  return stringLiteral;
}

/**
 * Returns true if node is a property access of `child` on the identifier `parent`.
 */
function isPropertyAccess(node: ts.Node, parent: string, child: string): boolean {
  if (!ts.isPropertyAccessExpression(node)) return false;
  return ts.isIdentifier(node.expression) && node.expression.escapedText === parent &&
      node.name.escapedText === child;
}

/** Returns true if expr is "module.exports = ...;". */
function isModuleExportsAssignment(expr: ts.ExpressionStatement): boolean {
  if (!ts.isBinaryExpression(expr.expression)) return false;
  if (expr.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  return isPropertyAccess(expr.expression.left, 'module', 'exports');
}

/** Returns true if expr is "exports = ...;". */
function isExportsAssignment(expr: ts.ExpressionStatement): boolean {
  if (!ts.isBinaryExpression(expr.expression)) return false;
  if (expr.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  return ts.isIdentifier(expr.expression.left) && expr.expression.left.text === 'exports';
}

/** isUseStrict returns true if node is a "use strict"; statement. */
function isUseStrict(node: ts.Node): boolean {
  if (node.kind !== ts.SyntaxKind.ExpressionStatement) return false;
  const exprStmt = node as ts.ExpressionStatement;
  const expr = exprStmt.expression;
  if (expr.kind !== ts.SyntaxKind.StringLiteral) return false;
  const literal = expr as ts.StringLiteral;
  return literal.text === 'use strict';
}

/**
 * TypeScript inserts the following code to mark ES moduels in CommonJS:
 *   Object.defineProperty(exports, "__esModule", { value: true });
 * This matches that code snippet.
 */
function isEsModuleProperty(stmt: ts.ExpressionStatement): boolean {
  // We're matching the explicit source text generated by the TS compiler.
  // Object.defineProperty(exports, "__esModule", { value: true });
  const expr = stmt.expression;
  if (!ts.isCallExpression(expr)) return false;
  if (!isPropertyAccess(expr.expression, 'Object', 'defineProperty')) return false;
  if (expr.arguments.length !== 3) return false;
  const [exp, esM, val] = expr.arguments;
  if (!ts.isIdentifier(exp) || exp.escapedText !== 'exports') return false;
  if (!ts.isStringLiteral(esM) || esM.text !== '__esModule') return false;
  if (!ts.isObjectLiteralExpression(val) || val.properties.length !== 1) return false;
  const prop = val.properties[0];
  if (!ts.isPropertyAssignment(prop)) return false;
  const ident = prop.name;
  if (!ident || !ts.isIdentifier(ident) || ident.text !== 'value') return false;
  return prop.initializer.kind === ts.SyntaxKind.TrueKeyword;
}

/**
 * Returns the string argument if call is of the form
 *   require('foo')
 */
function extractRequire(call: ts.CallExpression): string|null {
  // Verify that the call is a call to require(...).
  if (call.expression.kind !== ts.SyntaxKind.Identifier) return null;
  const ident = call.expression as ts.Identifier;
  if (ident.escapedText !== 'require') return null;

  // Verify the call takes a single string argument and grab it.
  if (call.arguments.length !== 1) return null;
  const arg = call.arguments[0];
  if (arg.kind !== ts.SyntaxKind.StringLiteral) return null;
  return (arg as ts.StringLiteral).text;
}

/** Creates a call expression corresponding to `goog.${methodName}(${literal})`. */
function createGoogCall(methodName: string, literal: ts.StringLiteral): ts.CallExpression {
  return ts.createCall(
      ts.createPropertyAccess(ts.createIdentifier('goog'), methodName), undefined, [literal]);
}

/**
 * Extracts the namespace part of a goog: import URL, or returns null if the given import URL is not
 * a goog: import.
 *
 * For example, for `import 'goog:foo.Bar';`, returns `foo.Bar`.
 */
export function extractGoogNamespaceImport(tsImport: string): string|null {
  if (tsImport.match(/^goog:/)) return tsImport.substring('goog:'.length);
  return null;
}

// Matches common extensions of TypeScript input filenames
const TS_EXTENSIONS = /(\.ts|\.d\.ts|\.js|\.jsx|\.tsx)$/;

/**
 * Convert from implicit `import {} from 'pkg'` to `import {} from 'pkg/index'.
 * TypeScript supports the shorthand, but not all ES6 module loaders do.
 * Workaround for https://github.com/Microsoft/TypeScript/issues/12597
 */
export function resolveIndexShorthand(
    host: {options: ts.CompilerOptions, host: ts.ModuleResolutionHost}, fileName: string,
    imported: string): string {
  const resolved = ts.resolveModuleName(imported, fileName, host.options, host.host);
  if (!resolved || !resolved.resolvedModule) return imported;
  const requestedModule = imported.replace(TS_EXTENSIONS, '');
  const resolvedModule = resolved.resolvedModule.resolvedFileName.replace(TS_EXTENSIONS, '');
  if (resolvedModule.indexOf('node_modules') === -1 &&
      requestedModule.substr(requestedModule.lastIndexOf('/')) !==
          resolvedModule.substr(resolvedModule.lastIndexOf('/'))) {
    imported = './' + path.relative(path.dirname(fileName), resolvedModule).replace(path.sep, '/');
  }
  return imported;
}

/**
 * importPathToGoogNamespace converts a TS/ES module './import/path' into a goog.module compatible
 * namespace, handling regular imports and `goog:` namespace imports.
 */
function importPathToGoogNamespace(
    host: GoogModuleProcessorHost, file: ts.SourceFile, tsImport: string): ts.StringLiteral {
  let modName: string;
  let isGoogImport = false;
  const nsImport = extractGoogNamespaceImport(tsImport);
  if (nsImport !== null) {
    // This is a namespace import, of the form "goog:foo.bar".
    // Fix it to just "foo.bar".
    modName = nsImport;
    isGoogImport = true;
  } else {
    if (host.convertIndexImportShorthand) {
      tsImport = resolveIndexShorthand(host, file.fileName, tsImport);
    }
    modName = host.pathToModuleName(file.fileName, tsImport);
  }
  return createSingleQuoteStringLiteral(modName);
}

/**
 * Replace "module.exports = ..." with just "exports = ...". Returns null if `expr` is not an
 * exports assignment.
 */
function rewriteModuleExportsAssignment(expr: ts.ExpressionStatement) {
  if (!ts.isBinaryExpression(expr.expression)) return null;
  if (expr.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;
  if (!isPropertyAccess(expr.expression.left, 'module', 'exports')) return null;
  const modPropAccess = expr.expression.left as ts.PropertyAccessExpression;
  return ts.setOriginalNode(
      ts.setTextRange(
          ts.createStatement(
              ts.createAssignment(ts.createIdentifier('exports'), expr.expression.right)),
          expr),
      expr);
}

/**
 * commonJsToGoogmoduleTransformer returns a transformer factory that converts TypeScript's CommonJS
 * module emit to Closure Compiler compatible goog.module and goog.require statements.
 */
export function commonJsToGoogmoduleTransformer(
    host: GoogModuleProcessorHost, modulesManifest: ModulesManifest, typeChecker: ts.TypeChecker,
    diagnostics: ts.Diagnostic[]): (context: ts.TransformationContext) =>
    ts.Transformer<ts.SourceFile> {
  return (context: ts.TransformationContext): ts.Transformer<ts.SourceFile> => {
    // TS' CommonJS processing uses onSubstituteNode to, at the very end of processing, substitute
    // "modulename.default" for default imports. We intercept the substitution here, check if it's a
    // .default access, then check if the original node (and thus original import) was from a goog:
    // module, and if so, replace with just the module name.
    const previousOnSubstituteNode = context.onSubstituteNode;
    context.enableSubstitution(ts.SyntaxKind.PropertyAccessExpression);
    context.onSubstituteNode = (hint, node: ts.Node): ts.Node => {
      node = previousOnSubstituteNode(hint, node);
      if (!ts.isPropertyAccessExpression(node)) return node;
      if (node.name.text !== 'default') return node;
      if (!ts.isIdentifier(node.expression)) return node;
      const lhs = node.expression.text;
      // Find the import declaration this node comes from.
      // This may be the original node, if the identifier was transformed from it.
      const orig = ts.getOriginalNode(node.expression);
      let importExportDecl: ts.ImportDeclaration|ts.ExportDeclaration;
      if (ts.isImportDeclaration(orig) || ts.isExportDeclaration(orig)) {
        importExportDecl = orig;
      } else {
        // Alternatively, we can try to find the declaration of the symbol. This only works for
        // user-written .default accesses, the generated ones do not have a symbol associated as
        // they are only produced in the CommonJS transformation, after type checking.
        const sym = typeChecker.getSymbolAtLocation(node.expression);
        if (!sym) return node;
        const decls = sym.getDeclarations();
        if (!decls || !decls.length) return node;
        const decl = decls[0];
        if (decl.parent && decl.parent.parent && ts.isImportDeclaration(decl.parent.parent)) {
          importExportDecl = decl.parent.parent;
        } else {
          return node;
        }
      }
      // If the import declaration's URL is a "goog:..." style namespace, then all ".default"
      // accesses on it should be replaced with the symbol itself.
      // This allows referring to the module-level export of a "goog.module" or "goog.provide" as if
      // it was an ES6 default export.
      if (extractGoogNamespaceImport((importExportDecl.moduleSpecifier as ts.StringLiteral).text)) {
        // Substitute "foo.default" with just "foo".
        return node.expression;
      }
      return node;
    };

    return (sf: ts.SourceFile): ts.SourceFile => {
      let moduleVarCounter = 1;
      /**
       * Creates a new unique variable to assign side effect imports into. This allows us to re-use
       * the variable later on for other imports of the same namespace.
       */
      function nextModuleVar() {
        return `tsickle_module_${moduleVarCounter++}_`;
      }

      /**
       * Maps goog.require namespaces to the variable name they are assigned into. E.g.:
       *     var $varName = goog.require('$namespace'));
       */
      const namespaceToModuleVarName = new Map<string, ts.Identifier>();

      /**
       * maybeCreateGoogRequire returns a `goog.require()` call for the given CommonJS `require`
       * call. Returns null if `call` is not a CommonJS require.
       */
      function maybeCreateGoogRequire(
          original: ts.Statement, call: ts.CallExpression, newIdent: ts.Identifier): ts.Statement|
          null {
        const importedUrl = extractRequire(call);
        if (!importedUrl) return null;
        const imp = importPathToGoogNamespace(host, sf, importedUrl);
        modulesManifest.addReferencedModule(sf.fileName, imp.text);
        const ident: ts.Identifier|undefined = namespaceToModuleVarName.get(imp.text);
        let initializer: ts.Expression;
        if (!ident) {
          namespaceToModuleVarName.set(imp.text, newIdent);
          initializer = createGoogCall('require', imp);
        } else {
          initializer = ident;
        }
        const varDecl = ts.createVariableDeclaration(newIdent, /* type */ undefined, initializer);
        const newStmt = ts.createVariableStatement(
            /* modifiers */ undefined, ts.createVariableDeclarationList([varDecl]));
        return ts.setOriginalNode(ts.setTextRange(newStmt, original), original);
      }

      /**
       * maybeRewriteRequireTslib rewrites a require('tslib') calls to goog.require('tslib'). It
       * returns the input statement untouched if it does not match.
       */
      function maybeRewriteRequireTslib(stmt: ts.Statement): ts.Statement {
        if (!ts.isExpressionStatement(stmt)) return stmt;
        if (!ts.isCallExpression(stmt.expression)) return stmt;
        const callExpr = stmt.expression;
        if (!ts.isIdentifier(callExpr.expression) || callExpr.expression.text !== 'require') {
          return stmt;
        }
        if (callExpr.arguments.length !== 1) return stmt;
        const arg = callExpr.arguments[0];
        if (!ts.isStringLiteral(arg) || arg.text !== 'tslib') return stmt;
        return ts.setOriginalNode(
            ts.setTextRange(ts.createStatement(createGoogCall('require', arg)), stmt), stmt);
      }

      /**
       * visitTopLevelStatement implements the main CommonJS to goog.module conversion. It visits a
       * SourceFile level statement and adds a (possibly) transformed representation of it into
       * statements. It adds at least one node per statement to statements.
       *
       * visitTopLevelStatement:
       * - converts require() calls to goog.require() calls, with or w/o var assignment
       * - removes "use strict"; and "Object.defineProperty(__esModule)" statements
       * - converts module.exports assignments to just exports assignments
       * - splits __exportStar() calls into require and export (this needs two statements)
       * - makes sure to only import each namespace exactly once, and use variables later on
       */
      function visitTopLevelStatement(
          statements: ts.Statement[], sf: ts.SourceFile, node: ts.Statement): void {
        // Handle each particular case by adding node to statements, then return.
        // For unhandled cases, break to jump to the default handling below.
        switch (node.kind) {
          case ts.SyntaxKind.ExpressionStatement: {
            const exprStmt = node as ts.ExpressionStatement;
            // Check for "use strict" and certain Object.defineProperty and skip it if necessary.
            if (isUseStrict(exprStmt) || isEsModuleProperty(exprStmt)) {
              stmts.push(ts.createNotEmittedStatement(exprStmt));
              return;
            }
            // Check for:
            //   module.exports = ...;
            const modExports = rewriteModuleExportsAssignment(exprStmt);
            if (modExports) {
              stmts.push(modExports);
              return;
            }
            // Check for:
            //   "require('foo');" (a require for its side effects)
            const expr = exprStmt.expression;
            if (!ts.isCallExpression(expr)) break;
            let callExpr = expr;
            // Handle export * in ES5 mode (in ES6 mode, export * is dereferenced already).
            // export * creates either a pure top-level '__export(require(...))' or the imported
            // version, 'tslib.__exportStar(require(...))'. The imported version is only substituted
            // later on though, so appears as a plain "__exportStar" on the top level here.
            const isExportStar =
                (ts.isIdentifier(expr.expression) && expr.expression.text === '__exportStar') ||
                (ts.isIdentifier(expr.expression) && expr.expression.text === '__export');
            if (isExportStar) callExpr = expr.arguments[0] as ts.CallExpression;
            const ident = ts.createIdentifier(nextModuleVar());
            const require = maybeCreateGoogRequire(exprStmt, callExpr, ident);
            if (!require) break;
            statements.push(require);
            // If this is an export star, split it up into the import (created by the maybe call
            // above), and the export operation. This avoids a Closure complaint about non-top-level
            // requires.
            if (isExportStar) {
              const args: ts.Expression[] = [ident];
              if (expr.arguments.length > 1) args.push(expr.arguments[1]);
              statements.push(ts.createStatement(ts.createCall(expr.expression, undefined, args)));
            }
            return;
          }
          case ts.SyntaxKind.VariableStatement: {
            // It's possibly of the form "var x = require(...);".
            const varStmt = node as ts.VariableStatement;
            // Verify it's a single decl (and not "var x = ..., y = ...;").
            if (varStmt.declarationList.declarations.length !== 1) break;
            const decl = varStmt.declarationList.declarations[0];

            // Grab the variable name (avoiding things like destructuring binds).
            if (decl.name.kind !== ts.SyntaxKind.Identifier) break;
            const ident = decl.name;
            if (!decl.initializer || !ts.isCallExpression(decl.initializer)) {
              break;
            }
            const require = maybeCreateGoogRequire(varStmt, decl.initializer, decl.name);
            if (!require) break;
            statements.push(require);
            return;
          }
          default:
            break;
        }
        statements.push(node);
      }

      const moduleName = host.pathToModuleName('', sf.fileName);
      // Register the namespace this file provides.
      modulesManifest.addModule(sf.fileName, moduleName);

      // In JS transpilation mode, keep all CommonJS code, and only rewrite `require('tslib')` to
      // a goog.require().
      if (host.isJsTranspilation) {
        const stmts: ts.Statement[] = [];
        for (const stmt of sf.statements) {
          stmts.push(maybeRewriteRequireTslib(stmt));
        }
        return ts.updateSourceFileNode(sf, stmts);
      }

      // Convert each top level statement to goog.module.
      const stmts: ts.Statement[] = [];
      for (const stmt of sf.statements) {
        visitTopLevelStatement(stmts, sf, stmt);
      }

      // Additional statements that will be prepended (goog.module call etc).
      const headerStmts: ts.Statement[] = [];

      // Emit: goog.module('moduleName');
      const googModule =
          ts.createStatement(createGoogCall('module', createSingleQuoteStringLiteral(moduleName)));
      headerStmts.push(googModule);

      // Allow code to use `module.id` to discover its module URL, e.g. to resolve a template URL
      // against. Uses 'var', as this code is inserted in ES6 and ES5 modes. The following pattern
      // ensures closure doesn't throw an error in advanced optimizations mode.
      // var module = module || {id: 'path/to/module.ts'};
      const moduleId = host.fileNameToModuleId(sf.fileName);
      const moduleVarInitializer = ts.createBinary(
          ts.createIdentifier('module'), ts.SyntaxKind.BarBarToken,
          ts.createObjectLiteral(
              [ts.createPropertyAssignment('id', createSingleQuoteStringLiteral(moduleId))]));
      const modAssign = ts.createVariableStatement(
          /* modifiers */ undefined, ts.createVariableDeclarationList([ts.createVariableDeclaration(
                                         'module', /* type */ undefined, moduleVarInitializer)]));
      headerStmts.push(modAssign);

      if (!host.es5Mode) {
        // The module=module assignment suppresses an unused variable warning which may trigger
        // depending on the project's compilation flags.
        headerStmts.push(ts.createStatement(
            ts.createAssignment(ts.createIdentifier('module'), ts.createIdentifier('module'))));

        // The `exports = {}` serves as a default export to disable Closure Compiler's error
        // checking
        // for mutable exports. That's OK because TS compiler makes sure that consuming code always
        // accesses exports through the module object, so mutable exports work.
        // It is only inserted in ES6 because we strip `.default` accesses in ES5 mode, which breaks
        // when assigning an `exports = {}` object and then later accessing it.
        // However Closure bails if code later on assigns into exports directly, as we do if we have
        // an "exports = " block, so skip emit if that's the case.
        if (!sf.statements.find(
                s => ts.isExpressionStatement(s) &&
                    (isModuleExportsAssignment(s) || isExportsAssignment(s)))) {
          headerStmts.push(ts.createStatement(
              ts.createAssignment(ts.createIdentifier('exports'), ts.createObjectLiteral())));
        }
      }

      // Insert goog.module() etc after any leading comments in the source file. The comments have
      // been converted to NotEmittedStatements by transformer_util, which this depends on.
      let insertionIdx = 0;
      if (stmts.length && stmts[0].kind === ts.SyntaxKind.NotEmittedStatement) {
        insertionIdx = 1;
      }
      stmts.splice(insertionIdx, 0, ...headerStmts);

      return ts.updateSourceFileNode(sf, stmts);
    };
  };
}