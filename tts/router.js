document.addEventListener('DOMContentLoaded', () => {
    // Create and add the loading bar to the page
    createLoadingBar();
    
    // Initialize router
    initRouter();
});

function createLoadingBar() {
    // Create loading bar container
    const loadingBarContainer = document.createElement('div');
    loadingBarContainer.id = 'loading-bar-container';
    loadingBarContainer.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 3px;
        z-index: 9999;
        pointer-events: none;
        display: none;
    `;
    
    // Create the actual loading bar
    const loadingBar = document.createElement('div');
    loadingBar.id = 'loading-bar';
    loadingBar.style.cssText = `
        height: 100%;
        width: 0%;
        background: linear-gradient(to right, #4cd964, #5ac8fa, #007aff, #34aadc, #5856d6, #ff2d55);
        background-size: 500% 100%;
        animation: loading-animation 2s infinite linear;
        transition: width 0.3s ease-out;
    `;
    
    // Add the animation style
    const style = document.createElement('style');
    style.textContent = `
        @keyframes loading-animation {
            0% { background-position: 0% 0; }
            100% { background-position: 100% 0; }
        }
    `;
    
    // Append elements to the DOM
    document.head.appendChild(style);
    loadingBarContainer.appendChild(loadingBar);
    document.body.appendChild(loadingBarContainer);
}

function showLoadingBar() {
    const container = document.getElementById('loading-bar-container');
    const bar = document.getElementById('loading-bar');
    
    // Reset and show loading bar
    container.style.display = 'block';
    bar.style.width = '15%'; // Start with a small width
    
    // Simulate progress
    setTimeout(() => { bar.style.width = '40%'; }, 200);
    setTimeout(() => { bar.style.width = '65%'; }, 600);
    setTimeout(() => { bar.style.width = '80%'; }, 1200);
}

function hideLoadingBar(success = true) {
    const container = document.getElementById('loading-bar-container');
    const bar = document.getElementById('loading-bar');
    
    if (success) {
        // Complete the bar animation
        bar.style.width = '100%';
        
        // Hide after completion
        setTimeout(() => {
            container.style.display = 'none';
            bar.style.width = '0%';
        }, 300);
    } else {
        // Change to error color and then hide
        bar.style.background = '#ff3b30';
        setTimeout(() => {
            container.style.display = 'none';
            bar.style.width = '0%';
            // Reset the original gradient
            bar.style.background = 'linear-gradient(to right, #4cd964, #5ac8fa, #007aff, #34aadc, #5856d6, #ff2d55)';
            bar.style.backgroundSize = '500% 100%';
        }, 500);
    }
}

function initRouter() {
    // Handle click events on all potential links and buttons
    document.addEventListener('click', (e) => {
        // First, check if it's a button with data-href attribute
        if (e.target.tagName === 'BUTTON' && e.target.getAttribute('data-href')) {
            e.preventDefault();
            navigateTo(e.target.getAttribute('data-href'));
            return;
        }
        
        // Handle regular links - find the nearest anchor tag
        let element = e.target;
        
        // Traverse up the DOM to find if the clicked element or any of its parents is an <a> tag
        while (element && element !== document && element.tagName !== 'A') {
            element = element.parentElement;
        }
        
        // If we found a link
        if (element && element.tagName === 'A') {
            const href = element.getAttribute('href');
            
            // Skip if it's not a valid href
            if (!href) return;
            
            // Determine if this is an internal link that should be handled by our router
            const isInternalLink = isInternalUrl(href);
            
            if (isInternalLink) {
                // Prevent default for internal links
                e.preventDefault();
                navigateTo(href);
            }
            // External links, hash links, mail links, etc. will be handled normally
        }
    });

    // Handle browser back/forward buttons
    window.addEventListener('popstate', (e) => {
        if (e.state && e.state.url) {
            loadContent(e.state.url, false);
        }
    });
}

function isInternalUrl(url) {
    // Check if the URL is internal
    if (url.startsWith('http://') || 
        url.startsWith('https://') || 
        url.startsWith('//')) {
        // Check if it's still on the same domain
        const linkElement = document.createElement('a');
        linkElement.href = url;
        return linkElement.hostname === window.location.hostname;
    }
    
    // Skip special URLs that shouldn't be handled by the router
    return !(
        url.startsWith('#') || 
        url.startsWith('javascript:') ||
        url.startsWith('mailto:') ||
        url.startsWith('tel:') ||
        url.startsWith('sms:') ||
        url.startsWith('file:') ||
        url.includes('://') // Any other protocol
    );
}

function navigateTo(url) {
    // Don't navigate if it's the current page
    const fullCurrentPath = window.location.pathname + window.location.search + window.location.hash;
    
    if (url === fullCurrentPath) {
        return;
    }
    
    // Update browser history
    window.history.pushState({ url }, '', url);
    
    // Load the content
    loadContent(url, true);
}

function loadContent(url, updateActive) {
    // Show loading indicator
    showLoadingBar();
    
    // Fetch the HTML content from the requested page
    fetch(url)
        .then(response => {
            if (!response.ok) {
                throw new Error(`Network response was not ok: ${response.status}`);
            }
            return response.text();
        })
        .then(html => {
            // Create a temporary element to parse the HTML
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            
            // Extract the content div
            const contentElement = doc.getElementById('content');
            
            if (!contentElement) {
                throw new Error('Content element not found in the loaded page');
            }
            
            const newContent = contentElement.innerHTML;
            
            // Update the page content
            const currentContentElement = document.getElementById('content');
            if (currentContentElement) {
                currentContentElement.innerHTML = newContent;
            } else {
                throw new Error('Content element not found in the current page');
            }
            
            // Update page title
            document.title = doc.title;
            
            // Update active link if needed
            if (updateActive) {
                updateActiveLink(url);
            }
            
            // Execute any scripts in the new content
            executeScripts(document.getElementById('content'));
            
            // Hide loading bar with success
            hideLoadingBar(true);
            
            // Scroll to top
            window.scrollTo(0, 0);
            
            // Dispatch a custom event for page change
            window.dispatchEvent(new CustomEvent('pageChanged', { detail: { url } }));
        })
        .catch(error => {
            console.error('Error loading page:', error);
            
            // Show error in content area
            const contentElement = document.getElementById('content');
            if (contentElement) {
                contentElement.innerHTML = `
                    <div style="padding: 20px; text-align: center;">
                        <h2>Error Loading Page</h2>
                        <p>Sorry, there was a problem loading the requested page.</p>
                        <p>Error: ${error.message}</p>
                        <button onclick="window.location.reload()">Reload Page</button>
                    </div>
                `;
            }
            
            // Hide loading bar with error state
            hideLoadingBar(false);
        });
}

function updateActiveLink(url) {
    // Extract just the pathname from the URL
    const pathname = new URL(url, window.location.origin).pathname;
    
    // Remove active class from all navigation links
    document.querySelectorAll('a').forEach(link => {
        if (link.classList.contains('active')) {
            link.classList.remove('active');
        }
    });
    
    // Add active class to matching links
    document.querySelectorAll('a').forEach(link => {
        const linkPath = new URL(link.href, window.location.origin).pathname;
        if (linkPath === pathname) {
            link.classList.add('active');
        }
    });
}

// Function to execute scripts in dynamically loaded content
function executeScripts(container) {
    // Find all script tags in the container
    const scripts = container.querySelectorAll('script');
    scripts.forEach(oldScript => {
        const newScript = document.createElement('script');
        
        // Copy all attributes
        Array.from(oldScript.attributes).forEach(attr => {
            newScript.setAttribute(attr.name, attr.value);
        });
        
        // Copy the content
        newScript.textContent = oldScript.textContent;
        
        // Replace the old script with the new one
        oldScript.parentNode.replaceChild(newScript, oldScript);
    });
}
