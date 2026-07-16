export namespace main {
	
	export class Bootstrap {
	    screenW: number;
	    screenH: number;
	    workBottom: number;
	    packs: workshop.PackInfo[];
	    steam: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Bootstrap(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.screenW = source["screenW"];
	        this.screenH = source["screenH"];
	        this.workBottom = source["workBottom"];
	        this.packs = this.convertValues(source["packs"], workshop.PackInfo);
	        this.steam = source["steam"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace workshop {
	
	export class PackInfo {
	    id: string;
	    source: string;
	    name: string;
	
	    static createFrom(source: any = {}) {
	        return new PackInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.source = source["source"];
	        this.name = source["name"];
	    }
	}

}

