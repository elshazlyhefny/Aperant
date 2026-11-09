export interface DetectedTool {
  id: string;
  name: string;
  path: string;
  installed: boolean;
}

export interface DetectedTools {
  ides: DetectedTool[];
  terminals: DetectedTool[];
  clis: DetectedTool[];
}
