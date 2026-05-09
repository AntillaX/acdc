class Player {
  constructor(id, name, ws) {
    this.id = id;
    this.name = name;
    this.ws = ws;
    this.connected = true;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      connected: this.connected,
    };
  }
}

module.exports = Player;
