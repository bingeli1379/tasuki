// What a plugin's own check found (config-and-rules.md, doctor). An error refuses the start;
// a warning is printed and the engine starts anyway.
export interface DoctorFinding {
  level: 'error' | 'warning'
  message: string
}
