export class ToolHost {
  constructor() {
    this.definitions = []
    this.tools = {
      register: (definition) => {
        this.definitions.push(definition)
        return () => {
          const index = this.definitions.indexOf(definition)
          if (index >= 0) this.definitions.splice(index, 1)
        }
      }
    }
  }
}
