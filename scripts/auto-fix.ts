import { Project, SyntaxKind } from "ts-morph";
import * as fs from "fs";

const project = new Project({ tsConfigFilePath: "./tsconfig.json" });

// First, fix missing types in parameters to avoid TS7006
project.getSourceFiles().forEach(sourceFile => {
  let changed = false;
  sourceFile.getDescendantsOfKind(SyntaxKind.Parameter).forEach(param => {
    if (!param.getTypeNode() && !param.getInitializer() && param.getName() !== "this") {
      try { param.setType("any"); changed = true; } catch(e) {}
    }
  });
  sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration).forEach(varDecl => {
    if (!varDecl.getTypeNode() && !varDecl.getInitializer()) {
      try { varDecl.setType("any"); changed = true; } catch(e) {}
    }
  });
  if (changed) sourceFile.saveSync();
});

project.resolveSourceFileDependencies();

// Now get diagnostics and insert @ts-expect-error
let diagnostics = project.getPreEmitDiagnostics();
let passes = 0;

while (diagnostics.length > 0 && passes < 3) {
  passes++;
  console.log(`Pass ${passes}: Found ${diagnostics.length} diagnostics.`);
  const fileUpdates = new Map<string, number[]>();
  
  for (const d of diagnostics) {
    const file = d.getSourceFile();
    if (file && d.getStart() !== undefined) {
      const path = file.getFilePath();
      const pos = d.getStart()!;
      const line = file.getLineAndColumnAtPos(pos).line;
      if (!fileUpdates.has(path)) fileUpdates.set(path, []);
      fileUpdates.get(path)!.push(line);
    }
  }

  for (const [path, lines] of fileUpdates.entries()) {
    const file = project.getSourceFile(path);
    if (!file) continue;
    
    // sort descending so inserting lines doesn't offset subsequent inserts
    const sortedLines = [...new Set(lines)].sort((a, b) => b - a);
    for (const line of sortedLines) {
      const text = file.getFullText();
      const lineStarts = [0];
      for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') lineStarts.push(i + 1);
      }
      const lineStart = lineStarts[line - 1];
      if (lineStart === undefined) continue;
      const lineText = text.substring(lineStart, lineStarts[line] || text.length);
      
      if (!lineText.includes("@ts-expect-error") && !lineText.includes("@ts-ignore")) {
        const match = lineText.match(/^(\s*)/);
        const indent = match ? match[1] : "";
        file.insertText(lineStart, `${indent}// @ts-ignore\n`);
      }
    }
    file.saveSync();
  }
  
  diagnostics = project.getPreEmitDiagnostics();
}

console.log("Done. Remaining diagnostics:", diagnostics.length);
