class Pathfinding {
    static getNeighbors(q, r) {
        return [
            { q: q + 1, r: r },
            { q: q + 1, r: r - 1 },
            { q: q, r: r - 1 },
            { q: q - 1, r: r },
            { q: q - 1, r: r + 1 },
            { q: q, r: r + 1 }
        ];
    }

    static distance(q1, r1, q2, r2) {
        return (Math.abs(q1 - q2) + Math.abs(q1 + r1 - q2 - r2) + Math.abs(r1 - r2)) / 2;
    }

    static findPath(startQ, startR, targetQ, targetR, getHexCost) {
        const startNode = { q: startQ, r: startR, g: 0, h: this.distance(startQ, startR, targetQ, targetR), f: 0, parent: null };
        startNode.f = startNode.g + startNode.h;
        const openList = [startNode];
        const closedList = new Set();
        const openMap = new Map();
        openMap.set(`${startQ},${startR}`, startNode);

        while (openList.length > 0) {
            openList.sort((a, b) => a.f - b.f);
            const currentNode = openList.shift();
            openMap.delete(`${currentNode.q},${currentNode.r}`);
            closedList.add(`${currentNode.q},${currentNode.r}`);

            if (currentNode.q === targetQ && currentNode.r === targetR) {
                const path = [];
                let curr = currentNode;
                while (curr !== null) {
                    path.unshift({ q: curr.q, r: curr.r });
                    curr = curr.parent;
                }
                return path; // includes start and end
            }

            const neighbors = this.getNeighbors(currentNode.q, currentNode.r);
            for (const neighbor of neighbors) {
                const hexId = `${neighbor.q},${neighbor.r}`;
                if (closedList.has(hexId)) continue;

                // getHexCost returns Infinity if impassable, else returns a numeric cost (e.g. 1/speed)
                const costMultiplier = getHexCost(neighbor.q, neighbor.r);
                if (costMultiplier === Infinity) continue;

                // Cap search space for performance
                if (Math.abs(neighbor.q) > 200 || Math.abs(neighbor.r) > 200) continue;

                const gScore = currentNode.g + costMultiplier;
                const hScore = this.distance(neighbor.q, neighbor.r, targetQ, targetR);
                const fScore = gScore + hScore;

                if (openMap.has(hexId)) {
                    const existingNode = openMap.get(hexId);
                    if (gScore < existingNode.g) {
                        existingNode.g = gScore;
                        existingNode.f = fScore;
                        existingNode.parent = currentNode;
                    }
                } else {
                    const neighborNode = { q: neighbor.q, r: neighbor.r, g: gScore, h: hScore, f: fScore, parent: currentNode };
                    openList.push(neighborNode);
                    openMap.set(hexId, neighborNode);
                }
            }
        }

        return null; // no path found
    }
}

module.exports = Pathfinding;
