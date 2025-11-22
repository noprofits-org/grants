import { DataManager } from './data.js';
import { NetworkVisualization } from './network.js';
import { Controls } from './controls.js';

export class GrantVisualizer {
    constructor() {
        this.dataManager = new DataManager();
        this.networkViz = null;
        this.controls = null;
        this.currentFilters = null;
        this.loadingOverlay = null;
    }

    showLoading(message = 'Loading...') {
        if (!this.loadingOverlay) {
            this.loadingOverlay = document.getElementById('loadingOverlay');
        }
        if (this.loadingOverlay) {
            const loadingText = this.loadingOverlay.querySelector('.loading-text');
            if (loadingText) {
                loadingText.textContent = message;
            }
            this.loadingOverlay.classList.add('active');
        }
    }

    hideLoading() {
        if (this.loadingOverlay) {
            this.loadingOverlay.classList.remove('active');
        }
    }

    async initialize() {
        try {
            // Show loading indicator
            this.showLoading('Loading grant data...');

            // Load initial data but don't visualize yet
            await this.dataManager.loadData();

            this.hideLoading();

            // Initialize visualization
            const svg = d3.select('#network');
            const width = window.innerWidth;
            const height = window.innerHeight;

            this.networkViz = new NetworkVisualization(svg, width, height);

            // Initialize controls
            this.controls = new Controls(this.dataManager, this.handleUpdate.bind(this), this.networkViz);

            // Display initial message
            this.showWelcomeMessage();

            // Handle window resize
            window.addEventListener('resize', () => this.handleResize());

        } catch (error) {
            console.error("Initialization failed:", error);
            this.showError("Failed to initialize visualization: " + error.message);
        }
    }

    showWelcomeMessage() {
        const svg = d3.select('#network');
        svg.selectAll("*").remove();

        const centerX = window.innerWidth / 2;
        const centerY = window.innerHeight / 2;

        // Add welcome group
        const welcomeGroup = svg.append("g")
            .attr("class", "welcome-message");

        // Main title
        welcomeGroup.append("text")
            .attr("x", centerX)
            .attr("y", centerY - 80)
            .attr("text-anchor", "middle")
            .attr("fill", "white")
            .attr("font-size", "32px")
            .attr("font-weight", "bold")
            .text("Nonprofit Grant Flow Network");

        // Subtitle
        welcomeGroup.append("text")
            .attr("x", centerX)
            .attr("y", centerY - 40)
            .attr("text-anchor", "middle")
            .attr("fill", "#94a3b8")
            .attr("font-size", "18px")
            .text("Visualize grant relationships and taxpayer funding impact");

        // Instructions
        welcomeGroup.append("text")
            .attr("x", centerX)
            .attr("y", centerY + 20)
            .attr("text-anchor", "middle")
            .attr("fill", "white")
            .attr("font-size", "16px")
            .text("Enter an organization name or EIN in the search box to begin");

        // Examples
        welcomeGroup.append("text")
            .attr("x", centerX)
            .attr("y", centerY + 60)
            .attr("text-anchor", "middle")
            .attr("fill", "#94a3b8")
            .attr("font-size", "14px")
            .text("Try using the Quick Filters below for common visualizations");

        // Add decorative elements
        const iconSize = 60;
        welcomeGroup.append("circle")
            .attr("cx", centerX)
            .attr("cy", centerY - 160)
            .attr("r", iconSize / 2)
            .attr("fill", "none")
            .attr("stroke", "#4299e1")
            .attr("stroke-width", 3);

        welcomeGroup.append("circle")
            .attr("cx", centerX - 15)
            .attr("cy", centerY - 165)
            .attr("r", 8)
            .attr("fill", "#ef4444");

        welcomeGroup.append("circle")
            .attr("cx", centerX + 15)
            .attr("cy", centerY - 155)
            .attr("r", 6)
            .attr("fill", "#84cc16");

        // Add connecting line
        welcomeGroup.append("line")
            .attr("x1", centerX - 15)
            .attr("y1", centerY - 165)
            .attr("x2", centerX + 15)
            .attr("y2", centerY - 155)
            .attr("stroke", "#4299e1")
            .attr("stroke-width", 2)
            .attr("marker-end", "url(#welcome-arrow)");

        // Add arrow marker for welcome message
        const defs = svg.select("defs").empty() ? svg.append("defs") : svg.select("defs");
        defs.append("marker")
            .attr("id", "welcome-arrow")
            .attr("viewBox", "0 -5 10 10")
            .attr("refX", 8)
            .attr("refY", 0)
            .attr("markerWidth", 6)
            .attr("markerHeight", 6)
            .attr("orient", "auto")
            .append("path")
            .attr("d", "M0,-5L10,0L0,5")
            .attr("fill", "#4299e1");
    }

    showError(message) {
        const errorDiv = document.createElement('div');
        errorDiv.style.position = 'fixed';
        errorDiv.style.top = '50%';
        errorDiv.style.left = '50%';
        errorDiv.style.transform = 'translate(-50%, -50%)';
        errorDiv.style.background = 'rgba(239, 68, 68, 0.9)';
        errorDiv.style.padding = '20px';
        errorDiv.style.borderRadius = '8px';
        errorDiv.textContent = message;
        document.body.appendChild(errorDiv);
    }

    async handleUpdate(filters) {
        this.currentFilters = filters;
        try {
            if (!filters.orgFilter) {
                this.showWelcomeMessage();
                return;
            }

            this.showLoading('Updating visualization...');

            // Use setTimeout to allow loading indicator to render
            setTimeout(() => {
                try {
                    const filteredData = this.dataManager.filterData(filters);

                    // Update stats display
                    this.controls.updateStats(filteredData.stats);

                    // Update visualization with color scheme
                    this.networkViz.update(filteredData, this.dataManager.originalData.charities, filters.colorScheme);

                    this.hideLoading();
                } catch (error) {
                    this.hideLoading();
                    console.error('Update error:', error);
                    this.showError('Failed to update visualization: ' + error.message);
                }
            }, 50);
        } catch (error) {
            this.hideLoading();
            console.error('Update error:', error);
            this.showError('Failed to update visualization: ' + error.message);
        }
    }

    handleResize() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        this.networkViz.resize(width, height);

        if (this.currentFilters) {
            this.handleUpdate(this.currentFilters).catch(console.error);
        } else {
            this.showWelcomeMessage();
        }
    }
}